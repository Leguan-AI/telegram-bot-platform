import { NextRequest, NextResponse } from 'next/server';
import {
  assertInstallationNotSuspended,
  assertInstallationOwner,
  exchangeUserCode,
  findUserInstallation,
  getAuthenticatedUser,
  isGitHubAppConfigured,
  revokeUserToken,
  GitHubConnectError,
} from '@/lib/githubApp';
import { completeGitHubConnect, ConnectDbError, isConnectTokenShape } from '@/lib/githubConnect';
import type { ConnectResultCode } from '@/lib/githubConnectUi';

// A handful of sequential GitHub calls plus one database round trip.
export const maxDuration = 30;

/**
 * GitHub App connect callback (#21 §2).
 *
 * The entity always comes from the `state` token; `installation_id` arrives as a URL
 * parameter and is treated as forgeable, so before anything is written we check that the
 * installation is one the authorizing user can see AND that they own its account
 * (matched by `account.id`). The user token exists only inside this request and is
 * revoked at GitHub on the way out, success or failure.
 *
 * No outcome detail is passed through the redirect: the status page takes a fixed result
 * code and nothing else, so a hand-crafted URL cannot put chosen text on our page.
 *
 * The browser's /manage session is deliberately not consulted here. The dashboard keeps
 * its Supabase session in the browser, not in a cookie this route could read, and the
 * owner arrives from GitHub in whatever browser they installed from — on the invite path
 * they have no /manage account at all. The token carries the binding instead: it names the
 * entity and the admin who issued it, and complete_github_connect re-checks on the server
 * that that admin is still an entity admin before writing anything.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const state = params.get('state') || '';
  const code = params.get('code') || '';
  const installationIdRaw = params.get('installation_id') || '';

  // GitHub also redirects here when an owner changes an existing installation's repo
  // selection from its own settings page ("Redirect on update"). There is no token to
  // attribute that to an entity, and nothing to record: the webhook (#21 §4) refreshes
  // the stored selection.
  if (!state) {
    return redirectToStatus(req, 'missing_state');
  }

  if (!isConnectTokenShape(state)) {
    return redirectToStatus(req, 'invalid_token');
  }

  if (!isGitHubAppConfigured()) {
    console.error('GitHub connect callback reached while the GitHub App env vars are unset.');
    return redirectToStatus(req, 'server_error');
  }

  // Without `code` we cannot verify ownership, which usually means the App's "Request
  // user authorization (OAuth) during installation" setting is off.
  if (!code) {
    return redirectToStatus(req, 'missing_code');
  }

  const installationId = Number(installationIdRaw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return redirectToStatus(req, 'missing_installation');
  }

  let userToken: string | null = null;

  try {
    userToken = await exchangeUserCode(code);

    const user = await getAuthenticatedUser(userToken);

    // Check one: the forged-id gate. The installation must be visible to this user.
    const installation = await findUserInstallation(userToken, installationId);
    if (!installation) {
      console.warn(`GitHub connect: installation ${installationId} not listed for the authorizing user.`);
      return redirectToStatus(req, 'not_owner');
    }

    // Check two: they must own the account the installation belongs to.
    await assertInstallationOwner(userToken, user, installation);

    // A suspended installation cannot be connected at all — see the note on the guard.
    assertInstallationNotSuspended(installation);

    const result = await completeGitHubConnect({
      code: state,
      installationId: installation.id,
      accountId: installation.accountId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      githubUserId: user.id,
      githubLogin: user.login,
    });

    if (result.outcome === 'already_connected') {
      // The owner re-ran the flow, most likely to change the repo selection; the account
      // login and selection we just stored overwrote what was there.
      console.info(
        `GitHub connect: refreshed installation ${installation.id} on entity ${result.entityId} ` +
          `(status ${result.status}, repository_selection ${result.repositorySelection}).`
      );
    }

    return redirectToStatus(req, result.outcome, result.repositorySelection, {
      flow: result.kind,
      entityId: result.entityId,
    });
  } catch (err) {
    if (err instanceof ConnectDbError) {
      console.warn(`GitHub connect refused: ${err.reason}`);
      return redirectToStatus(req, err.reason === 'db_error' ? 'server_error' : err.reason);
    }
    if (err instanceof GitHubConnectError) {
      console.warn(`GitHub connect failed: ${err.reason} — ${err.message}`);
      return redirectToStatus(req, mapGitHubReason(err.reason));
    }
    console.error('GitHub connect callback failed:', err);
    return redirectToStatus(req, 'server_error');
  } finally {
    if (userToken) {
      try {
        await revokeUserToken(userToken);
      } catch (revokeErr) {
        console.warn('GitHub user-token revocation failed:', revokeErr);
      }
    }
  }
}

function mapGitHubReason(reason: string): ConnectResultCode {
  switch (reason) {
    case 'not_owner':
    case 'installation_suspended':
    case 'account_mismatch':
    case 'membership_forbidden':
    case 'unsupported_account':
    case 'unsupported_selection':
      return reason;
    default:
      // code_exchange_failed, user_lookup_failed, installations_lookup_failed,
      // membership_lookup_failed — transport, not a verdict about the user.
      return 'github_error';
  }
}

function redirectToStatus(
  req: NextRequest,
  result: ConnectResultCode,
  selection?: 'all' | 'selected',
  context?: { flow: 'direct' | 'invite'; entityId: string }
): NextResponse {
  const url = new URL('/github/connect/status', req.nextUrl.origin);
  url.searchParams.set('result', result);
  if (selection) {
    url.searchParams.set('selection', selection);
  }
  // Only ever set on success, where we know both for certain. The status page validates
  // them anyway: an enum and a UUID, so neither can put text on the page.
  if (context) {
    url.searchParams.set('flow', context.flow);
    url.searchParams.set('entity', context.entityId);
  }
  return NextResponse.redirect(url);
}
