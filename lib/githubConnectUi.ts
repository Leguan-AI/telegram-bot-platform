/**
 * Shared copy for the GitHub connect surfaces (#21 §8, §3).
 *
 * The disclosures must read the same on the /manage connect panel, the connect-invite
 * landing page and the GitHub App's public description, so they live here once. The App
 * description is set by hand in GitHub (see DEPLOYMENT.md, "GitHub App setup") — keep it
 * in step with this list.
 *
 * No server-only imports: the /manage panel is a client component.
 */

export const GITHUB_CONNECT_DISCLOSURES: string[] = [
  'The bot reads the repositories you share read-only. It never writes code, opens pull requests or files issues.',
  'Repository content may be processed by third-party AI model providers in order to answer questions.',
  'Admins of the workspace you are connecting to will be able to make the shared repositories readable by the bot in their Telegram groups.',
  'Files that look like secrets — .env files, private keys, credential files — are never available to the bot.',
];

/**
 * The "All repositories" warning (§3). Shown wherever a repository_selection of `all` is
 * visible: the invite landing page, the completion page, the confirmation card and the
 * GitHub tab.
 */
export const ALL_REPOS_WARNING =
  'With "All repositories", workspace admins can link any repository in the account to a Telegram group — including repositories created later, which GitHub adds to the installation automatically. Choosing "Only select repositories" instead keeps that list under your control.';

/**
 * The same point once the choice has already been made, where "please choose" would read
 * as a verdict on a connection that in fact succeeded.
 */
export const ALL_REPOS_SHARED_NOTE =
  'That is allowed, and the connection is fine — but it means workspace admins can link any repository in the account to a Telegram group, including ones created later, which GitHub adds automatically. You can narrow it to specific repositories at any time from the GitHub installation settings.';

/** Where an owner changes or removes what they shared. Lists every installation they own. */
export const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations';

/**
 * The settings page for one installation, where the account's owner adds or removes the
 * repositories shared with the App.
 *
 * Which repositories exist in the installation is GitHub's to decide, not ours: the App can read
 * them but can never widen or narrow its own grant. So the dashboard cannot offer "add a
 * repository" itself — it sends the owner to the page that can, and re-reads the list when they
 * come back. A personal installation lives under the user's own settings; an organization's under
 * the organization's.
 */
export function githubInstallationSettingsUrl(connection: {
  installation_id: number;
  account_login: string;
  account_type: 'User' | 'Organization';
}): string {
  if (connection.account_type === 'Organization') {
    return `https://github.com/organizations/${encodeURIComponent(connection.account_login)}/settings/installations/${connection.installation_id}`;
  }
  return `${GITHUB_INSTALLATIONS_URL}/${connection.installation_id}`;
}

/** Outcome of a callback, as carried in the status page's `result` parameter. */
export type ConnectResultCode =
  // success
  | 'connected'
  | 'pending_confirmation'
  | 'already_connected'
  // token problems
  | 'invalid_token'
  | 'revoked'
  | 'already_consumed'
  | 'expired'
  | 'issuer_not_admin'
  // installation problems
  | 'attached_elsewhere'
  | 'entity_slot_taken'
  // owner check
  | 'not_owner'
  | 'installation_suspended'
  | 'account_mismatch'
  | 'membership_forbidden'
  | 'unsupported_account'
  | 'unsupported_selection'
  // request / transport
  | 'missing_state'
  | 'missing_code'
  | 'missing_installation'
  | 'github_error'
  | 'server_error';

/**
 * Which flow produced this outcome. The next step differs: a /manage admin who connected
 * their own account goes back to the dashboard, while an invitee has no account here and
 * is simply done.
 */
export type ConnectFlow = 'direct' | 'invite';

export function parseConnectFlow(value: string | undefined): ConnectFlow | null {
  return value === 'direct' || value === 'invite' ? value : null;
}

export interface ConnectResultCopy {
  title: string;
  body: string;
  tone: 'success' | 'pending' | 'error';
}

const RESULT_COPY: Record<ConnectResultCode, ConnectResultCopy> = {
  connected: {
    title: 'GitHub connected',
    body: 'The repositories you shared are now available to the workspace, and nothing further is needed from you here. Which Telegram groups can read which repository is decided in the dashboard, under the GitHub tab.',
    tone: 'success',
  },
  pending_confirmation: {
    title: 'Almost there — the workspace admin will confirm',
    body: 'Thanks — nothing else is needed from you. The admin who sent you this invite now has to confirm the connection; until they do, no repository can be linked to a group and the bot cannot read anything.',
    tone: 'pending',
  },
  already_connected: {
    title: 'Already connected',
    body: 'This GitHub account is already connected to that workspace. If you changed which repositories are shared, the change applies automatically.',
    tone: 'success',
  },
  invalid_token: {
    title: 'This link is not valid',
    body: 'Ask the workspace admin for a fresh invite link.',
    tone: 'error',
  },
  revoked: {
    title: 'This invite was revoked',
    body: 'The workspace admin revoked this invite. Ask them for a new one.',
    tone: 'error',
  },
  already_consumed: {
    title: 'This link has already been used',
    body: 'Connect links work once. Ask the workspace admin for a fresh one.',
    tone: 'error',
  },
  expired: {
    title: 'This link has expired',
    body: 'Connect invites are valid for 24 hours. Ask the workspace admin for a new one.',
    tone: 'error',
  },
  issuer_not_admin: {
    title: 'This invite is no longer valid',
    body: 'The admin who issued it is no longer an admin of that workspace. Ask a current admin for a new invite.',
    tone: 'error',
  },
  attached_elsewhere: {
    title: 'This GitHub account is connected elsewhere',
    body: 'This installation is already connected to a different workspace. A GitHub account can be connected to one workspace at a time; remove the existing connection first.',
    tone: 'error',
  },
  entity_slot_taken: {
    title: 'That workspace already has a GitHub connection',
    body: 'A workspace can be connected to one GitHub account at a time. Ask the workspace admin to disconnect the current one first.',
    tone: 'error',
  },
  not_owner: {
    title: 'Only an owner can connect this account',
    body: 'Connecting needs an owner of the GitHub account or organization — access to a repository, or plain organization membership, is not enough. Nothing was recorded.',
    tone: 'error',
  },
  installation_suspended: {
    title: 'That installation is suspended on GitHub',
    body: 'Nothing was recorded. Unsuspend the app in the GitHub account or organization settings, then open the link again.',
    tone: 'error',
  },
  account_mismatch: {
    title: 'Could not verify ownership',
    body: 'The organization we verified did not match the installation. Nothing was recorded. Please try again.',
    tone: 'error',
  },
  membership_forbidden: {
    title: 'Could not check organization ownership',
    body: 'GitHub would not tell us whether you own this organization. This usually means the app is missing its "Members: Read-only" permission — please report it. Nothing was recorded.',
    tone: 'error',
  },
  unsupported_account: {
    title: 'Unsupported GitHub account',
    body: 'Only personal accounts and organizations can be connected. Nothing was recorded.',
    tone: 'error',
  },
  unsupported_selection: {
    title: 'Unexpected repository selection',
    body: 'GitHub reported a repository selection we do not understand. Nothing was recorded.',
    tone: 'error',
  },
  missing_state: {
    title: 'Nothing to do',
    body: 'GitHub sent us here without a connect link, so there is nothing to record. If you just changed which repositories are shared, the change applies on its own. To connect a workspace, start from the invite link or from the workspace dashboard.',
    tone: 'pending',
  },
  missing_code: {
    title: 'GitHub did not ask you to authorize',
    body: 'Connecting needs you to authorize as yourself, so we can verify you own the account — and GitHub did not offer that step, even after we asked for it directly. That points at the app\u2019s own settings rather than anything you did: "Request user authorization (OAuth) during installation" has to be on. Please report it; nothing was recorded.',
    tone: 'error',
  },
  missing_installation: {
    title: 'No installation to connect',
    body: 'GitHub sent us back without an installation. Please start again from the link.',
    tone: 'error',
  },
  github_error: {
    title: 'GitHub could not be reached',
    body: 'Something went wrong talking to GitHub. Nothing was recorded — please try the link again.',
    tone: 'error',
  },
  server_error: {
    title: 'Something went wrong',
    body: 'We could not complete the connection. Nothing was recorded — please try the link again.',
    tone: 'error',
  },
};

const RESULT_CODES = Object.keys(RESULT_COPY) as ConnectResultCode[];

/** Validates an untrusted `result` parameter; anything unknown becomes server_error. */
export function parseConnectResult(value: string | undefined): ConnectResultCode {
  const match = RESULT_CODES.find((code) => code === value);
  return match ?? 'server_error';
}

export function connectResultCopy(code: ConnectResultCode): ConnectResultCopy {
  return RESULT_COPY[code];
}
