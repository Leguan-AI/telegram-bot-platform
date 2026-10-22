import { NextRequest, NextResponse } from 'next/server';
import { getProfileIdFromRequest } from '@/lib/manageAuth';
import { getConnectionForAdmin, setRepoLinks, RepoLinkError } from '@/lib/repoLinks';
import {
  canMintInstallationTokens,
  listInstallationRepositories,
  mintInstallationToken,
  GitHubTokenError,
} from '@/lib/githubAppToken';

export const maxDuration = 30;

interface SaveBody {
  entityId?: unknown;
  groupId?: unknown;
  threadId?: unknown;
  repoIds?: unknown;
}

/**
 * Saves the repositories linked at one scope (#21 §3).
 *
 * **This endpoint is the security boundary.** Nothing the browser sends is trusted: the
 * acting user comes from a verified bearer token, their admin rights are re-checked in the
 * database, and every submitted repository id is re-checked against what the entity's
 * installation currently contains (R2-B1) — so a hand-crafted request cannot link a
 * repository the owner never shared, or one shared with a different workspace.
 *
 * The scope itself is re-checked by the `repo_links` trigger, which refuses a group from
 * another entity, a thread from another group, and a topic pin that would widen scope.
 */
export async function POST(req: NextRequest) {
  const profileId = await getProfileIdFromRequest(req);
  if (!profileId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const entityId = typeof body.entityId === 'string' ? body.entityId : '';
  const groupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null;
  const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : null;

  if (!entityId) {
    return NextResponse.json({ error: 'missing_entity' }, { status: 400 });
  }
  if (threadId && !groupId) {
    return NextResponse.json({ error: 'thread_without_group' }, { status: 400 });
  }

  // Repository ids are numeric GitHub ids; anything else is rejected rather than coerced.
  if (!Array.isArray(body.repoIds)) {
    return NextResponse.json({ error: 'invalid_repo_ids' }, { status: 400 });
  }
  const repoIds: number[] = [];
  for (const raw of body.repoIds) {
    const id = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'invalid_repo_ids' }, { status: 400 });
    }
    if (!repoIds.includes(id)) repoIds.push(id);
  }

  if (!canMintInstallationTokens()) {
    console.error('Repo link save reached while GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are unset.');
    return NextResponse.json({ error: 'app_not_configured' }, { status: 503 });
  }

  try {
    const connection = await getConnectionForAdmin(entityId, profileId);
    if (!connection) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 });
    }
    if (connection.status !== 'active') {
      return NextResponse.json({ error: connection.status }, { status: 409 });
    }

    // The re-check. Only a save that clears the set can skip asking GitHub, since an empty
    // selection cannot smuggle anything in.
    if (repoIds.length > 0) {
      const token = await mintInstallationToken({ installationId: connection.installationId });
      const available = new Set(
        (await listInstallationRepositories(token.token)).map((repo) => repo.id)
      );
      const rejected = repoIds.filter((id) => !available.has(id));
      if (rejected.length > 0) {
        console.warn(
          `Repo link save rejected ${rejected.length} repository id(s) outside installation ` +
            `${connection.installationId} on entity ${entityId}.`
        );
        return NextResponse.json({ error: 'repo_not_in_installation', rejected }, { status: 400 });
      }
    }

    const result = await setRepoLinks({ entityId, profileId, groupId, threadId, repoIds });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RepoLinkError) {
      const status = err.reason === 'forbidden' ? 403 : err.reason === 'no_connection' ? 409 : 500;
      return NextResponse.json({ error: err.reason }, { status });
    }
    if (err instanceof GitHubTokenError) {
      console.warn(`Repo link save failed: ${err.reason} — ${err.message}`);
      return NextResponse.json({ error: err.reason }, { status: 502 });
    }
    console.error('Repo link save failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
