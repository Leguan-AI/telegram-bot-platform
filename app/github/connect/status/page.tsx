import {
  ALL_REPOS_WARNING,
  connectResultCopy,
  parseConnectResult,
} from '@/lib/githubConnectUi';
import * as s from '../styles';

/**
 * Outcome page for the GitHub connect callback (#21 §2a step 4, §2b step 4).
 *
 * It renders one of a fixed set of result codes and nothing else: no workspace name, no
 * account login, no GitHub error text. A hand-crafted URL can therefore only pick which
 * of our own messages is shown.
 */
export default async function GitHubConnectStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string | string[]; selection?: string | string[] }>;
}) {
  const { result, selection } = await searchParams;
  const code = parseConnectResult(Array.isArray(result) ? result[0] : result);
  const copy = connectResultCopy(code);
  const sharedAll = (Array.isArray(selection) ? selection[0] : selection) === 'all';

  return (
    <main style={s.page}>
      <h1 style={{ ...s.heading, color: s.toneColor(copy.tone) }}>{copy.title}</h1>
      <p style={s.lead}>{copy.body}</p>

      {sharedAll && copy.tone !== 'error' && (
        <div style={s.warning}>
          <strong>You shared all repositories.</strong> {ALL_REPOS_WARNING}
        </div>
      )}

      <p style={s.muted}>
        You can change which repositories are shared, or remove the installation entirely, from
        the GitHub account or organization settings at any time.
      </p>
    </main>
  );
}
