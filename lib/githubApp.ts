/**
 * GitHub App — connect-flow client (#21 §1, §2).
 *
 * This module covers the *connect* half of the App: the install URL, the one-shot user
 * token exchange, the owner check, and revoking that token again. It deliberately holds
 * no installation-token minting (the App JWT): per-answer downscoped tokens and the
 * /manage repo picker arrive with the repo-tool work, and the connect flow never needs
 * them — every fact it relies on comes from the authorizing user's own token.
 *
 * Nothing here is ever persisted: the user token lives inside a single request and is
 * revoked at GitHub before the response is sent.
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_VERSION = '2022-11-28';

export type GitHubAccountType = 'User' | 'Organization';

export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHubInstallation {
  id: number;
  accountId: number;
  accountLogin: string;
  accountType: GitHubAccountType;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

/**
 * A connect attempt that failed a check rather than a transport. `reason` is a stable
 * token the callback maps to user-facing copy; it never carries GitHub's own text.
 */
export class GitHubConnectError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message || reason);
    this.name = 'GitHubConnectError';
  }
}

/** App slug — used only to build the install URL (`github.com/apps/<slug>`). */
export function getGitHubAppSlug(): string {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) {
    throw new Error('GITHUB_APP_SLUG is not set; the GitHub connect flow is unavailable.');
  }
  return slug;
}

/** OAuth credentials for the user-token exchange and revocation. */
function getOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not set; the GitHub connect flow is unavailable.'
    );
  }
  return { clientId, clientSecret };
}

/** True when the App is configured well enough to start a connect flow. */
export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_APP_CLIENT_ID &&
      process.env.GITHUB_APP_CLIENT_SECRET
  );
}

/**
 * The App install page, carrying our single-use state. GitHub sends the owner back to
 * the App's registered Callback URL with `code`, `installation_id`, `setup_action` and
 * this `state`; we never pass a redirect_uri, so the registered URL is the only
 * destination.
 */
export function buildInstallUrl(state: string): string {
  return `https://github.com/apps/${getGitHubAppSlug()}/installations/new?state=${encodeURIComponent(state)}`;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'telegram-bot-platform',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Exchanges the callback's `code` for a user access token. The token is scoped to the
 * App's own permissions and is revoked before this request returns.
 */
export async function exchangeUserCode(code: string): Promise<string> {
  const { clientId, clientSecret } = getOAuthCredentials();

  const res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'telegram-bot-platform',
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!res.ok) {
    throw new GitHubConnectError('code_exchange_failed', `GitHub token exchange failed (${res.status})`);
  }

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    // data.error is GitHub's own code (bad_verification_code, …) — logged, never shown.
    throw new GitHubConnectError('code_exchange_failed', `GitHub token exchange returned no token: ${data.error}`);
  }

  return data.access_token;
}

/** The authorizing user. Their numeric id is what the personal-account check compares. */
export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API}/user`, { headers: apiHeaders(token) });
  if (!res.ok) {
    throw new GitHubConnectError('user_lookup_failed', `GET /user failed (${res.status})`);
  }
  const data = (await res.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}

interface RawInstallation {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repository_selection: string;
  suspended_at: string | null;
}

/**
 * Looks for `installationId` among the installations the authorizing user can see.
 * `installation_id` reaches us as a URL parameter and can be forged, so this is the
 * first of the two checks in §2: no entry here, no connection.
 */
export async function findUserInstallation(
  token: string,
  installationId: number
): Promise<GitHubInstallation | null> {
  // The platform App on a personal account or a handful of orgs stays well inside one
  // page; paginate anyway so a user in many orgs is not silently cut off.
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
      headers: apiHeaders(token),
    });
    if (!res.ok) {
      throw new GitHubConnectError('installations_lookup_failed', `GET /user/installations failed (${res.status})`);
    }

    const data = (await res.json()) as { total_count: number; installations: RawInstallation[] };
    const list = data.installations || [];

    const match = list.find((i) => i.id === installationId);
    if (match) {
      if (!match.account) {
        throw new GitHubConnectError('unsupported_account', 'Installation has no account object');
      }
      if (match.account.type !== 'User' && match.account.type !== 'Organization') {
        throw new GitHubConnectError(
          'unsupported_account',
          `Unsupported installation account type: ${match.account.type}`
        );
      }
      if (match.repository_selection !== 'all' && match.repository_selection !== 'selected') {
        throw new GitHubConnectError(
          'unsupported_selection',
          `Unexpected repository_selection: ${match.repository_selection}`
        );
      }
      return {
        id: match.id,
        accountId: match.account.id,
        accountLogin: match.account.login,
        accountType: match.account.type,
        repositorySelection: match.repository_selection,
        suspended: match.suspended_at !== null,
      };
    }

    if (list.length < 100) break;
  }

  return null;
}

/**
 * Refuses a suspended installation (#21 §5 treats `suspended` as "repo tools
 * unavailable"). Nothing is recorded, so the entity's slot stays free and the owner can
 * unsuspend the App on GitHub and come back.
 *
 * Recording it as `status = 'suspended'` instead would be worse on the invite path: the
 * §4 `installation.unsuspend` webhook flips a suspended row to `active`, which would
 * activate a connection no workspace admin ever confirmed. A connect that cannot reach
 * `pending_confirmation` must not be stored at all.
 *
 * Call it only after the owner check, so a suspension is reported to owners alone.
 */
export function assertInstallationNotSuspended(installation: GitHubInstallation): void {
  if (installation.suspended) {
    throw new GitHubConnectError('installation_suspended', 'Installation is suspended on GitHub');
  }
}

/**
 * The owner check (§2). Repo access, or plain org membership, is not enough.
 *
 * - personal installation: the authorizing user's id must equal the installation's
 *   `account.id`;
 * - org installation: the user's org membership must be `role: admin` / `state: active`,
 *   **and the membership's organization id must equal the installation's `account.id`* —
 *   matched numerically, so a renamed org cannot turn into a mismatch (or a match).
 *
 * The org call needs the App's "Members: Read-only" organization permission: a GitHub
 * App's user tokens are limited to the App's own permissions, so without it the call
 * fails for every org. Per-answer installation tokens are downscoped to contents +
 * metadata and never carry it.
 */
export async function assertInstallationOwner(
  token: string,
  user: GitHubUser,
  installation: GitHubInstallation
): Promise<void> {
  if (installation.accountType === 'User') {
    if (user.id !== installation.accountId) {
      throw new GitHubConnectError('not_owner', 'Authorizing user is not the installation account');
    }
    return;
  }

  const res = await fetch(
    `${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(installation.accountLogin)}`,
    { headers: apiHeaders(token) }
  );

  if (res.status === 403) {
    // Typically the App is missing the Members: Read-only organization permission.
    throw new GitHubConnectError('membership_forbidden', 'GET /user/memberships/orgs failed with 403');
  }
  if (res.status === 404) {
    throw new GitHubConnectError('not_owner', 'Authorizing user has no membership in the installation org');
  }
  if (!res.ok) {
    throw new GitHubConnectError('membership_lookup_failed', `GET /user/memberships/orgs failed (${res.status})`);
  }

  const membership = (await res.json()) as {
    state: string;
    role: string;
    organization: { id: number; login: string } | null;
  };

  if (membership.role !== 'admin' || membership.state !== 'active') {
    throw new GitHubConnectError('not_owner', 'Authorizing user is not an active admin of the org');
  }
  if (!membership.organization || membership.organization.id !== installation.accountId) {
    throw new GitHubConnectError('account_mismatch', 'Membership org id does not match the installation account id');
  }
}

/**
 * Revokes the user token at GitHub (`DELETE /applications/{client_id}/token`). Called in
 * a finally block: the token is single-purpose and must not outlive the request, whether
 * or not the connection succeeded. Failures are logged, never surfaced — the token also
 * expires on its own ("Expire user authorization tokens" is on).
 */
export async function revokeUserToken(token: string): Promise<void> {
  const { clientId, clientSecret } = getOAuthCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'Content-Type': 'application/json',
      'User-Agent': 'telegram-bot-platform',
      Authorization: `Basic ${basic}`,
    },
    body: JSON.stringify({ access_token: token }),
  });

  if (!res.ok && res.status !== 404) {
    console.warn(`GitHub user-token revocation returned ${res.status}`);
  }
}
