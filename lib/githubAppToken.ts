/**
 * GitHub App installation tokens (#21 §1).
 *
 * The App's private key lives once in the environment and signs for every installation.
 * Two callers, two scopes:
 *
 *   * the /manage repo picker takes an **unscoped** token, so it can list every repository
 *     the owner shared. It runs server-side only and is never exposed to a model;
 *   * each answer takes a token **downscoped** to the repos in scope for that topic, with
 *     `contents` + `metadata` only — never the App's `members` permission, so an
 *     answer-time token cannot read org membership.
 *
 * Tokens live up to an hour, are kept in memory for the request that minted them, and are
 * never written to the database or logged.
 */

import { createSign } from 'node:crypto';

import { GITHUB_CALL_TIMEOUT_MS } from '@/lib/answerBudget';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Read-only scope for an answer-time token. Deliberately excludes `members`. */
export const READ_ONLY_REPO_PERMISSIONS = { contents: 'read', metadata: 'read' } as const;

/**
 * Scope for a token that only has to *name* repositories — the /manage picker and the save
 * endpoint's re-check. `GET /installation/repositories` needs `metadata` alone, so neither
 * token can read a single line of code, even though the App itself may.
 */
export const METADATA_ONLY_PERMISSIONS = { metadata: 'read' } as const;

export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** What GitHub actually granted, which is the authority — not what we asked for. */
  repositorySelection: string | null;
}

export interface InstallationRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

export class GitHubTokenError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message || reason);
    this.name = 'GitHubTokenError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The PEM as stored in the environment. Vercel and `.env` files commonly hold it on one
 * line with literal `\n` escapes, so those are turned back into real newlines; a genuine
 * multi-line value passes through untouched.
 */
export function normalizePrivateKey(raw: string): string {
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  return pem.trim() + '\n';
}

function getAppCredentials(): { appId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new GitHubTokenError(
      'app_not_configured',
      'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set; installation tokens are unavailable.'
    );
  }
  return { appId, privateKey: normalizePrivateKey(privateKey) };
}

/** True when the App can sign — i.e. installation tokens are available at all. */
export function canMintInstallationTokens(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

/**
 * An RS256 App JWT, signed with node:crypto — no new dependency.
 *
 * `iat` is backdated 60 seconds so a clock a little ahead of GitHub's does not produce
 * "issued at" failures, and `exp` is 9 minutes out, inside GitHub's 10-minute ceiling
 * even after the backdating.
 */
export function mintAppJwt(nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const { appId, privateKey } = getAppCredentials();

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })
  );
  const signingInput = `${header}.${payload}`;

  let signature: string;
  try {
    signature = base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKey));
  } catch (err) {
    // A malformed PEM lands here. The key itself must never reach the message.
    throw new GitHubTokenError('app_key_invalid', 'Could not sign the App JWT with GITHUB_APP_PRIVATE_KEY');
  }

  return `${signingInput}.${signature}`;
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'telegram-bot-platform',
    Authorization: `Bearer ${jwt}`,
  };
}

function installationHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'telegram-bot-platform',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Mints an installation token.
 *
 * Pass `repositoryIds` and `permissions` to downscope it; GitHub enforces the result, so
 * whatever the caller asks for afterwards, the token cannot reach a repository outside the
 * list. An empty `repositoryIds` array is refused rather than sent, because GitHub treats
 * an omitted list as "every repository in the installation" — the opposite of the intent.
 */
export async function mintInstallationToken(input: {
  installationId: number;
  repositoryIds?: number[];
  permissions?: Record<string, string>;
  /** A caller holding an answer deadline passes its own, already clamped to it. */
  signal?: AbortSignal;
}): Promise<InstallationToken> {
  if (input.repositoryIds && input.repositoryIds.length === 0) {
    throw new GitHubTokenError(
      'empty_repository_scope',
      'Refusing to mint a token for an empty repository list (GitHub would grant all of them).'
    );
  }

  const jwt = mintAppJwt();
  const body: Record<string, unknown> = {};
  if (input.repositoryIds) body.repository_ids = input.repositoryIds;
  if (input.permissions) body.permissions = input.permissions;

  const res = await fetch(`${GITHUB_API}/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...appHeaders(jwt), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal ?? AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS),
  });

  if (res.status === 404) {
    throw new GitHubTokenError('installation_gone', 'GitHub does not know this installation any more');
  }
  if (res.status === 403) {
    throw new GitHubTokenError('installation_suspended', 'GitHub refused a token for this installation');
  }
  if (!res.ok) {
    throw new GitHubTokenError('token_mint_failed', `POST /app/installations/{id}/access_tokens failed (${res.status})`);
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    repository_selection?: string;
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
    repositorySelection: data.repository_selection ?? null,
  };
}

/**
 * Every repository the installation can see, for the /manage picker. Needs an unscoped
 * token: a downscoped one would only list what it was already narrowed to.
 */
export async function listInstallationRepositories(
  token: string,
  signal?: AbortSignal
): Promise<InstallationRepository[]> {
  const repositories: InstallationRepository[] = [];
  // 100 per page. Far beyond any real installation — but a silently short list would make
  // the save endpoint reject a repository that *is* shared, so hitting the cap throws.
  const maxPages = 20;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: installationHeaders(token),
      // Per page, and the loop can run to 20 of them: without this, one slow response
      // holds up an answer that has a deadline of its own (#37 review B1).
      signal: signal ?? AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new GitHubTokenError(
        'repository_list_failed',
        `GET /installation/repositories failed (${res.status})`
      );
    }

    const data = (await res.json()) as {
      total_count: number;
      repositories: Array<{
        id: number;
        full_name: string;
        private: boolean;
        default_branch: string | null;
        description: string | null;
      }>;
    };

    const page_repos = data.repositories || [];
    for (const repo of page_repos) {
      repositories.push({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        // v1 follows the default branch only (§6); archived or empty repos can report none.
        defaultBranch: repo.default_branch || 'main',
        description: repo.description,
      });
    }

    if (page_repos.length < 100) {
      return repositories;
    }

    if (page === maxPages) {
      throw new GitHubTokenError(
        'repository_list_truncated',
        `Installation has more than ${maxPages * 100} repositories; raise the page cap rather than trusting a short list.`
      );
    }
  }

  return repositories;
}
