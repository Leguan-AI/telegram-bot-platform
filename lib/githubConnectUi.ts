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
  'Please choose "Only select repositories" on the GitHub screen. With "All repositories", workspace admins can link any repository in the account to a Telegram group — including repositories created later, which GitHub adds to the installation automatically.';

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

export interface ConnectResultCopy {
  title: string;
  body: string;
  tone: 'success' | 'pending' | 'error';
}

const RESULT_COPY: Record<ConnectResultCode, ConnectResultCopy> = {
  connected: {
    title: 'GitHub connected',
    body: 'The repositories you shared are now available to the workspace. Its admins decide which Telegram groups can use them.',
    tone: 'success',
  },
  pending_confirmation: {
    title: 'Almost there — the workspace admin will confirm',
    body: 'Thanks. The admin who sent you this invite now has to confirm the connection. Until they do, no repository can be linked to a group and the bot cannot read anything.',
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
    body: 'The connection needs you to authorize as yourself so we can verify you own the account. Please start again from the link; if it keeps happening, report it.',
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
