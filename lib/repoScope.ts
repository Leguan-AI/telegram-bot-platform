/**
 * What the bot can read here (#21 §3a).
 *
 * This is the narrow seam the issue asks for: one place that answers "which repositories
 * are in scope for this entity / group / topic", used by `/repos`, by `/context`, and —
 * when the answer-time tools land — by the descriptors and the downscoped token. Nothing
 * else should work that out for itself.
 *
 * Scope resolution: a topic pinned to repositories sees exactly those; otherwise the topic
 * inherits everything linked at group level plus everything linked entity-wide. Pins can
 * only narrow, which the repo_links trigger enforces on write.
 */

import { GITHUB_CALL_TIMEOUT_MS, type Deadline } from '@/lib/answerBudget';
import { withTenantContext } from '@/lib/supabase';
import {
  METADATA_ONLY_PERMISSIONS,
  canMintInstallationTokens,
  listInstallationRepositories,
  mintInstallationToken,
} from '@/lib/githubAppToken';
import type { ScopedRepo } from '@/lib/reposCommand';

export interface RepoScope {
  status: 'none' | 'pending_confirmation' | 'suspended' | 'active';
  accountLogin: string | null;
  /** The numeric GitHub installation id, which the answer-time token is minted against. */
  installationId: number | null;
  repos: ScopedRepo[];
  /** The topic is pinned, i.e. narrowed below what the group offers. */
  isPinned: boolean;
  /** GitHub would not give us names, so `shortName` falls back to the id. */
  namesUnavailable: boolean;
}

interface LinkRow {
  repo_id: string;
  group_id: string | null;
  thread_id: string | null;
}

/**
 * Resolves the repositories in scope for one message's group and topic.
 *
 * Names are read live from GitHub, because only the numeric id is stored (§3: a rename or
 * transfer must not be able to break a link or point it at a different repository). A
 * failed lookup degrades to ids rather than hiding repositories that really are in scope.
 */
export async function resolveRepoScope(input: {
  entityId: string;
  groupId: string;
  telegramThreadId: bigint | number | string | null;
  /**
   * The answer's deadline, where the caller has one (#37 review B1). The name lookup is
   * two GitHub calls and the listing pages, so without a bound it can eat an answer's
   * whole allowance before the first model call.
   */
  deadline?: Deadline;
}): Promise<RepoScope> {
  const threadIdStr =
    input.telegramThreadId !== null && input.telegramThreadId !== undefined
      ? input.telegramThreadId.toString()
      : null;

  const { connection, links } = await withTenantContext(input.entityId, async (tx) => {
    const installations = await tx<
      { installation_id: string; account_login: string; status: string }[]
    >`
      select installation_id::text, account_login, status
      from public.github_installations
      where entity_id = ${input.entityId}
    `;

    const linkRows = await tx<LinkRow[]>`
      select rl.repo_id::text, rl.group_id::text, rl.thread_id::text
      from public.repo_links rl
      left join public.threads t on t.id = rl.thread_id
      where rl.entity_id = ${input.entityId}
        and (rl.group_id is null or rl.group_id = ${input.groupId}::uuid)
        and (rl.thread_id is null or t.telegram_thread_id = ${threadIdStr}::bigint)
    `;

    return { connection: installations[0] || null, links: linkRows };
  });

  if (!connection) {
    return {
      status: 'none',
      accountLogin: null,
      installationId: null,
      repos: [],
      isPinned: false,
      namesUnavailable: false,
    };
  }

  const status = connection.status as RepoScope['status'];

  // A pinned topic sees its pins and nothing else; otherwise it inherits the group's and
  // the entity's links.
  const pins = links.filter((l) => l.thread_id !== null);
  const inherited = links.filter((l) => l.thread_id === null);
  const isPinned = pins.length > 0;
  const chosen = isPinned ? pins : inherited;

  const repoIds: number[] = [];
  for (const link of chosen) {
    const id = Number(link.repo_id);
    if (Number.isSafeInteger(id) && !repoIds.includes(id)) repoIds.push(id);
  }

  if (repoIds.length === 0 || status !== 'active') {
    // Nothing to name, or nothing usable: report the state and skip the GitHub call.
    return {
      status,
      accountLogin: connection.account_login,
      installationId: toInstallationId(connection.installation_id),
      repos: repoIds.map((repoId) => toUnnamedRepo(repoId, isPinned)),
      isPinned,
      namesUnavailable: false,
    };
  }

  const found = await lookupRepos(Number(connection.installation_id), repoIds, input.deadline);

  return {
    status,
    accountLogin: connection.account_login,
    installationId: toInstallationId(connection.installation_id),
    repos: repoIds.map((repoId) => {
      const repo = found.get(repoId);
      if (!repo) return toUnnamedRepo(repoId, isPinned);
      const fullName = repo.fullName;
      return {
        repoId,
        fullName,
        shortName: fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName,
        pinned: isPinned,
        defaultBranch: repo.defaultBranch,
        description: repo.description,
      };
    }),
    isPinned,
    // Any miss, not only a total failure: a partial lookup otherwise shows a bare #id with
    // nothing to explain it.
    namesUnavailable: found.size < repoIds.length,
  };
}

/** The id is stored as text to survive bigint; a value that will not parse is no id. */
function toInstallationId(raw: string | null): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toUnnamedRepo(repoId: number, pinned: boolean): ScopedRepo {
  return { repoId, fullName: `#${repoId}`, shortName: `#${repoId}`, pinned };
}

interface LookedUpRepo {
  fullName: string;
  defaultBranch: string;
  description: string | null;
}

/**
 * id → name, branch and description, from the installation itself. Metadata-only, so this
 * token cannot read a line of code. An empty map means GitHub did not answer; the caller
 * degrades to ids rather than pretending the repositories are not there.
 */
async function lookupRepos(
  installationId: number,
  repoIds: number[],
  deadline?: Deadline
): Promise<Map<number, LookedUpRepo>> {
  const found = new Map<number, LookedUpRepo>();
  if (!canMintInstallationTokens()) return found;

  // Whichever is shorter: one call's timeout, or what is left of the answer. A timeout
  // here degrades to ids and no tools, which is the fail-closed direction.
  const signal = deadline?.signal(GITHUB_CALL_TIMEOUT_MS);

  try {
    const token = await mintInstallationToken({
      installationId,
      permissions: { ...METADATA_ONLY_PERMISSIONS },
      signal,
    });
    for (const repo of await listInstallationRepositories(token.token, signal)) {
      if (repoIds.includes(repo.id)) {
        found.set(repo.id, {
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          description: repo.description,
        });
      }
    }
  } catch (err) {
    console.warn(`Could not read repository names for installation ${installationId}:`, err);
  }

  return found;
}

/**
 * Replaces this topic's pins (#21 §3a). The caller must already have established that the
 * sender is a group admin — the live getChatMember check — because nothing in the database
 * knows about Telegram admin rights.
 *
 * An empty list clears the pins, so the topic goes back to inheriting the group's
 * repositories. The repo_links trigger refuses anything that would widen scope, so a pin
 * for a repository that is not linked at group or entity level cannot be written here.
 */
export async function setTopicPins(input: {
  entityId: string;
  groupId: string;
  threadRowId: string;
  installationRowId: string;
  repoIds: number[];
  telegramUserId: bigint | number;
}): Promise<void> {
  const csv = input.repoIds.map((id) => id.toString()).join(',');

  await withTenantContext(input.entityId, async (tx) => {
    await tx`
      delete from public.repo_links
      where entity_id = ${input.entityId}
        and thread_id = ${input.threadRowId}::uuid
    `;

    if (input.repoIds.length === 0) return;

    await tx`
      insert into public.repo_links (
        entity_id, github_installation_id, group_id, thread_id, repo_id, linked_by_tg_user_id
      )
      select ${input.entityId}::uuid,
             ${input.installationRowId}::uuid,
             ${input.groupId}::uuid,
             ${input.threadRowId}::uuid,
             r,
             ${input.telegramUserId.toString()}::bigint
      from unnest(string_to_array(${csv}, ',')::bigint[]) as r
    `;
  });
}

/** The installation row a pin must attach to, and whether it can hold links at all. */
export async function getActiveInstallationRow(entityId: string): Promise<string | null> {
  return withTenantContext(entityId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from public.github_installations
      where entity_id = ${entityId} and status = 'active'
    `;
    return rows[0]?.id ?? null;
  });
}

/** The threads-registry row id for a topic, which pins reference. */
export async function getThreadRowId(input: {
  entityId: string;
  groupId: string;
  telegramThreadId: bigint | number;
}): Promise<string | null> {
  return withTenantContext(input.entityId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from public.threads
      where entity_id = ${input.entityId}
        and group_id = ${input.groupId}::uuid
        and telegram_thread_id = ${input.telegramThreadId.toString()}::bigint
    `;
    return rows[0]?.id ?? null;
  });
}
