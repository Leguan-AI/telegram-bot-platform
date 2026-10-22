/**
 * Repo links — database capabilities for the server routes (#21 §3).
 *
 * Both functions here are granted to `bot_service` only and take the acting profile as an
 * argument, because the routes run before any tenant context exists and cannot rely on
 * `auth.uid()`. Each one re-checks that profile's entity admin rights in the database, so
 * a route bug cannot turn into a cross-tenant write.
 */

import { sql } from '@/lib/supabase';

export interface AdminConnection {
  id: string;
  installationId: number;
  accountLogin: string;
  repositorySelection: 'all' | 'selected';
  status: 'pending_confirmation' | 'active' | 'suspended';
}

export class RepoLinkError extends Error {
  constructor(public readonly reason: 'forbidden' | 'no_connection' | 'db_error', message?: string) {
    super(message || reason);
    this.name = 'RepoLinkError';
  }
}

/** Postgres raises 42501 for the admin check; everything else is ours to report. */
function toRepoLinkError(err: unknown): RepoLinkError {
  const code = (err as { code?: string })?.code;
  if (code === '42501') {
    return new RepoLinkError('forbidden', 'Not an admin of this directory');
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'no_active_installation') {
    return new RepoLinkError('no_connection', message);
  }
  return new RepoLinkError('db_error', message);
}

/**
 * The entity's connection, as seen by an admin acting through a server route. Returns null
 * when the entity has no connection at all, and throws `forbidden` when the profile is not
 * an admin — the two cases a caller must not confuse.
 */
export async function getConnectionForAdmin(
  entityId: string,
  profileId: string
): Promise<AdminConnection | null> {
  try {
    const rows = await sql<{ result: Record<string, string | number> | null }[]>`
      select public.get_github_connection_for_admin(${entityId}, ${profileId}) as result
    `;
    const result = rows[0]?.result;
    if (!result) return null;

    return {
      id: String(result.id),
      installationId: Number(result.installation_id),
      accountLogin: String(result.account_login),
      repositorySelection: result.repository_selection as AdminConnection['repositorySelection'],
      status: result.status as AdminConnection['status'],
    };
  } catch (err) {
    throw toRepoLinkError(err);
  }
}

export interface SaveLinksResult {
  added: number;
  removed: number;
  total: number;
}

/**
 * Replaces the link set at exactly one scope: entity-level (no group), group-level (a
 * group), or a topic pin (a group and a thread). The caller must already have checked the
 * repository ids against the installation.
 */
export async function setRepoLinks(input: {
  entityId: string;
  profileId: string;
  groupId: string | null;
  threadId: string | null;
  repoIds: number[];
}): Promise<SaveLinksResult> {
  try {
    // The ids go over as one comma-separated string and are parsed in SQL, rather than
    // relying on the driver's array-element type inference to land on bigint. `nullif`
    // keeps an empty selection (which clears the scope) from becoming `{''}`.
    const csv = input.repoIds.map((id) => id.toString()).join(',');

    const rows = await sql<{ result: SaveLinksResult }[]>`
      select public.set_repo_links(
        ${input.entityId},
        ${input.profileId},
        ${input.groupId},
        ${input.threadId},
        string_to_array(nullif(${csv}, ''), ',')::bigint[]
      ) as result
    `;
    const result = rows[0]?.result;
    if (!result) {
      throw new RepoLinkError('db_error', 'No result returned from set_repo_links');
    }
    return result;
  } catch (err) {
    if (err instanceof RepoLinkError) throw err;
    throw toRepoLinkError(err);
  }
}
