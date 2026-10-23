import { peekConnectInvite, ConnectDbError } from '@/lib/githubConnect';
import { isGitHubAppConfigured } from '@/lib/githubApp';
import {
  GITHUB_CONNECT_DISCLOSURES,
  ALL_REPOS_WARNING,
  connectResultCopy,
  parseConnectResult,
  type ConnectResultCode,
} from '@/lib/githubConnectUi';
import * as s from './styles';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Agent Platform';

/**
 * Connect-invite landing page (#21 §2b step 2).
 *
 * The invitee needs no account here. The page names the workspace they are connecting
 * to, states the read-only scope and the §8 disclosures, recommends "Only select
 * repositories", and says that the workspace admin will confirm the connection before
 * anything can be read.
 *
 * The workspace name is looked up from the token server-side — it is never taken from
 * the URL — and the invite is not consumed by viewing this page.
 */
export default async function GitHubConnectInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[] }>;
}) {
  const { invite } = await searchParams;
  const code = Array.isArray(invite) ? invite[0] : invite;

  if (!code) {
    return <Problem result="invalid_token" />;
  }

  if (!isGitHubAppConfigured()) {
    console.error('GitHub connect invite opened while the GitHub App env vars are unset.');
    return <Problem result="server_error" />;
  }

  let entityName: string;
  let expiresAt: string;
  try {
    const preview = await peekConnectInvite(code);
    entityName = preview.entityName;
    expiresAt = preview.expiresAt;
  } catch (err) {
    if (err instanceof ConnectDbError) {
      return <Problem result={err.reason === 'db_error' ? 'server_error' : err.reason} />;
    }
    console.error('GitHub connect invite lookup failed:', err);
    return <Problem result="server_error" />;
  }

  return (
    <main style={s.page}>
      <h1 style={s.heading}>Connect a GitHub account to {entityName}</h1>
      <p style={s.lead}>
        An admin of <strong>{entityName}</strong> asked you to connect the GitHub account or
        organization you own, so their {APP_NAME} bot can read the code when someone asks it a
        question about the project.
      </p>

      <div style={s.panel}>
        <p style={{ marginTop: 0, fontWeight: 600 }}>What you are agreeing to</p>
        <ul style={{ marginBottom: 0 }}>
          {GITHUB_CONNECT_DISCLOSURES.map((line) => (
            <li key={line} style={{ marginBottom: '0.5rem' }}>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <div style={s.warning}>
        <strong>On the GitHub screen, choose &ldquo;Only select repositories&rdquo;.</strong>{' '}
        {ALL_REPOS_WARNING}
      </div>

      <p>
        On the next screen GitHub asks which repositories to share and asks you to authorize as
        yourself. Only an <strong>owner</strong> of the account or organization can complete this —
        we check that with GitHub.
      </p>
      <p>
        Afterwards, the admin who invited you <strong>confirms the connection</strong> in{' '}
        {APP_NAME}. Until they do, nothing can be linked to a Telegram group and the bot cannot
        read anything.
      </p>

      <p style={{ margin: '32px 0' }}>
        <a style={s.button} href={`/api/github/install?state=${encodeURIComponent(code)}`}>
          Continue to GitHub
        </a>
      </p>

      <p style={s.muted}>
        This link works once and expires {new Date(expiresAt).toUTCString()}. You can remove the
        installation on GitHub at any time, which takes the access away immediately.
      </p>
    </main>
  );
}

function Problem({ result }: { result: ConnectResultCode }) {
  const copy = connectResultCopy(parseConnectResult(result));
  return (
    <main style={s.page}>
      <h1 style={{ ...s.heading, color: s.toneColor(copy.tone) }}>{copy.title}</h1>
      <p style={s.lead}>{copy.body}</p>
    </main>
  );
}
