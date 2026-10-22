import {
  ALL_REPOS_SHARED_NOTE,
  GITHUB_INSTALLATIONS_URL,
  connectResultCopy,
  parseConnectFlow,
  parseConnectResult,
  type ConnectFlow,
  type ConnectResultCode,
} from '@/lib/githubConnectUi';
import * as s from '../styles';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Agent Platform';

/** Entity ids arrive in a URL, so they are only used after proving they are a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Outcome page for the GitHub connect callback (#21 §2a step 4, §2b step 4).
 *
 * It renders one of a fixed set of result codes, plus two enums (the flow, and whether
 * all repositories were shared) and an entity id that must parse as a UUID. Everything
 * shown is our own copy: a hand-crafted URL can only pick which of our messages appears
 * and which directory a link points at, never put text on the page.
 *
 * Every outcome offers a way onward. Landing here used to be a dead end, which left an
 * owner unsure whether a connection had actually been made.
 */
export default async function GitHubConnectStatusPage({
  searchParams,
}: {
  searchParams: Promise<{
    result?: string | string[];
    selection?: string | string[];
    flow?: string | string[];
    entity?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const code = parseConnectResult(first(params.result));
  const copy = connectResultCopy(code);
  const flow = parseConnectFlow(first(params.flow));
  const sharedAll = first(params.selection) === 'all';

  const entityId = first(params.entity);
  const dashboardHref = entityId && UUID.test(entityId)
    ? `/manage/entities/${entityId}`
    : '/manage/dashboard';

  return (
    <main style={s.page}>
      <h1 style={{ ...s.heading, color: s.toneColor(copy.tone) }}>{copy.title}</h1>
      <p style={s.lead}>{copy.body}</p>

      {sharedAll && copy.tone !== 'error' && (
        <div style={s.warning}>
          <strong>You shared all repositories.</strong> {ALL_REPOS_SHARED_NOTE}
        </div>
      )}

      <NextSteps code={code} flow={flow} dashboardHref={dashboardHref} />
    </main>
  );
}

/**
 * What to do from here. An invitee has no dashboard account, so they are only ever
 * offered GitHub; anyone else gets the directory they started from.
 */
function NextSteps({
  code,
  flow,
  dashboardHref,
}: {
  code: ConnectResultCode;
  flow: ConnectFlow | null;
  dashboardHref: string;
}) {
  // An invitee has no dashboard account, and neither has anyone whose connection is
  // waiting on an admin — that outcome only arises through an invite.
  const showDashboard = flow !== 'invite' && code !== 'pending_confirmation';

  return (
    <>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '32px 0' }}>
        {showDashboard && (
          <a style={s.button} href={dashboardHref}>
            Back to {APP_NAME}
          </a>
        )}
        <a
          style={showDashboard ? { ...s.button, ...s.buttonSecondary } : s.button}
          href={GITHUB_INSTALLATIONS_URL}
        >
          Change what is shared on GitHub
        </a>
      </div>

      <p style={s.muted}>
        On GitHub you can change which repositories are shared, or remove the installation,
        at any time. The repository list in the dashboard reflects changes immediately.
      </p>
    </>
  );
}
