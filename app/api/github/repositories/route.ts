import { NextRequest, NextResponse } from 'next/server';
import { getProfileIdFromRequest } from '@/lib/manageAuth';
import { getConnectionForAdmin, RepoLinkError } from '@/lib/repoLinks';
import {
  canMintInstallationTokens,
  listInstallationRepositories,
  mintInstallationToken,
  GitHubTokenError,
} from '@/lib/githubAppToken';

// One token mint plus a page or two of repositories.
export const maxDuration = 30;

/**
 * The /manage repo picker's source of truth (#21 §3).
 *
 * Repository names are never stored — a rename or transfer must not be able to break a
 * link or point it at a different repository — so the picker reads them live, with an
 * **unscoped** installation token. That token exists only inside this request and is never
 * returned to the browser or shown to a model.
 *
 * No GitHub authorization from the user is involved: the owner's repository selection on
 * GitHub is the grant, and an entity admin is entitled to see what it contains.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get('entity') || '';
  if (!entityId) {
    return NextResponse.json({ error: 'missing_entity' }, { status: 400 });
  }

  const profileId = await getProfileIdFromRequest(req);
  if (!profileId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!canMintInstallationTokens()) {
    console.error('Repo picker reached while GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are unset.');
    return NextResponse.json({ error: 'app_not_configured' }, { status: 503 });
  }

  try {
    const connection = await getConnectionForAdmin(entityId, profileId);
    if (!connection) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 });
    }
    if (connection.status !== 'active') {
      // A connection awaiting confirmation, or suspended, holds the slot and nothing else.
      return NextResponse.json({ error: connection.status }, { status: 409 });
    }

    const token = await mintInstallationToken({ installationId: connection.installationId });
    const repositories = await listInstallationRepositories(token.token);

    return NextResponse.json({
      accountLogin: connection.accountLogin,
      repositorySelection: connection.repositorySelection,
      repositories,
    });
  } catch (err) {
    if (err instanceof RepoLinkError) {
      return NextResponse.json({ error: err.reason }, { status: err.reason === 'forbidden' ? 403 : 500 });
    }
    if (err instanceof GitHubTokenError) {
      console.warn(`Repo picker failed: ${err.reason} — ${err.message}`);
      return NextResponse.json({ error: err.reason }, { status: 502 });
    }
    console.error('Repo picker failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
