import { NextRequest, NextResponse } from 'next/server';
import { buildInstallUrl, isGitHubAppConfigured } from '@/lib/githubApp';
import { isConnectTokenShape } from '@/lib/connectState';

/**
 * Hands a connect token off to GitHub's App install screen (#21 §2a step 1, §2b step 3).
 *
 * The App slug is config the server owns, so the browser never needs it: /manage mints a
 * `direct` state and sends the admin here, and the invite landing page sends the invitee
 * here with the invite token. The only destination is the App's own install URL, with the
 * token as `state`.
 */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get('state') || '';

  if (!isConnectTokenShape(state)) {
    return NextResponse.redirect(new URL('/github/connect/status?result=invalid_token', req.nextUrl.origin));
  }

  if (!isGitHubAppConfigured()) {
    console.error('GitHub connect attempted while the GitHub App env vars are unset.');
    return NextResponse.redirect(new URL('/github/connect/status?result=server_error', req.nextUrl.origin));
  }

  return NextResponse.redirect(buildInstallUrl(state));
}
