/**
 * The `/repos` command: parsing, name resolution and replies (#21 §3a, §9).
 *
 * Pure — no database, no network, no Telegram. The route supplies what is in scope and
 * who is asking; everything decided here is a function of those inputs, which is what
 * makes the rules testable.
 *
 * The rules that matter, and why:
 *   * the group and topic always come from the message, never from an argument, so a
 *     member cannot pin someone else's topic;
 *   * repository names resolve only against what is already linked to this group, so a
 *     typo cannot reach a repository nobody shared;
 *   * pins only ever narrow. The database enforces that too (the repo_links trigger), but
 *     a clear reply beats a constraint violation.
 */

/** A repository the bot can reach here, as the route resolved it. */
export interface ScopedRepo {
  repoId: number;
  /** `owner/name` as GitHub reports it. */
  fullName: string;
  /** Just the repository part — one account per entity makes the owner redundant in chat. */
  shortName: string;
  /** True when this repo is in scope because the topic is pinned to it. */
  pinned: boolean;
}

export type ReposCommand =
  | { action: 'view' }
  | { action: 'pin'; names: string[] }
  | { action: 'unpin'; names: string[] }
  | { action: 'clear' }
  | { action: 'help'; reason: 'unknown_subcommand' | 'missing_names'; subcommand?: string };

/**
 * Parses `/repos`, `/repos@thebot`, `/repos pin a b`, `/repos unpin a`, `/repos clear`.
 * Unknown subcommands become help rather than being guessed at.
 */
export function parseReposCommand(rawText: string): ReposCommand {
  const withoutCommand = rawText.trim().replace(/^\/repos(@\S+)?/i, '').trim();
  if (withoutCommand === '') return { action: 'view' };

  const [subcommand, ...rest] = withoutCommand.split(/\s+/);
  const names = rest.filter((n) => n.length > 0);

  switch (subcommand.toLowerCase()) {
    case 'pin':
      return names.length > 0 ? { action: 'pin', names } : { action: 'help', reason: 'missing_names', subcommand: 'pin' };
    case 'unpin':
      return names.length > 0
        ? { action: 'unpin', names }
        : { action: 'help', reason: 'missing_names', subcommand: 'unpin' };
    case 'clear':
      return { action: 'clear' };
    default:
      return { action: 'help', reason: 'unknown_subcommand', subcommand };
  }
}

export interface ResolvedNames {
  repos: ScopedRepo[];
  /** Names that matched nothing linked to this group. */
  unknown: string[];
}

/**
 * Resolves typed names against the repositories linked here, case-insensitively, by short
 * name or by `owner/name`. Anything else is reported back rather than ignored, so a typo
 * never silently pins a different repository — or nothing at all.
 */
export function resolveRepoNames(available: ScopedRepo[], names: string[]): ResolvedNames {
  const repos: ScopedRepo[] = [];
  const unknown: string[] = [];

  for (const raw of names) {
    const wanted = raw.trim().toLowerCase().replace(/^@/, '');
    const match = available.find(
      (repo) => repo.shortName.toLowerCase() === wanted || repo.fullName.toLowerCase() === wanted
    );
    if (!match) {
      unknown.push(raw);
    } else if (!repos.some((r) => r.repoId === match.repoId)) {
      repos.push(match);
    }
  }

  return { repos, unknown };
}

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One repository as a chat line: short name, with the owner only on request. */
function repoLine(repo: ScopedRepo): string {
  return `${repo.pinned ? '📌 ' : '• '}<code>${esc(repo.shortName)}</code>`;
}

export interface RepoScopeView {
  /** The connection's state, which decides whether any of this is usable. */
  status: 'none' | 'pending_confirmation' | 'suspended' | 'active';
  repos: ScopedRepo[];
  /** True when the topic is pinned, i.e. narrowed below what the group offers. */
  isPinned: boolean;
  /** True when we are in a topic at all (pins need one). */
  inTopic: boolean;
  /** Repository names could not be read from GitHub; ids are shown instead. */
  namesUnavailable?: boolean;
}

/** The `/repos` listing, and the same block `/context` embeds. */
export function buildRepoListing(view: RepoScopeView): string {
  if (view.status === 'none') {
    return '<b>Repositories</b>\n<i>No GitHub account is connected to this workspace.</i>';
  }
  if (view.status === 'pending_confirmation') {
    return '<b>Repositories</b>\n<i>A GitHub connection is waiting for a workspace admin to confirm it. Nothing can be read until then.</i>';
  }
  if (view.status === 'suspended') {
    return '<b>Repositories</b>\n<i>The GitHub installation is suspended, so I cannot read any code right now.</i>';
  }
  if (view.repos.length === 0) {
    return '<b>Repositories</b>\n<i>None linked here yet. A workspace admin links them in the dashboard.</i>';
  }

  const lines = ['<b>Repositories</b>'];
  if (view.namesUnavailable) {
    lines.push('<i>GitHub did not answer just now, so these are repository ids.</i>');
  }
  lines.push(...view.repos.map(repoLine));
  lines.push(
    view.isPinned
      ? '<i>📌 This topic is pinned to the repositories above.</i>'
      : view.inTopic
        ? "<i>Inherited from the group — this topic is not pinned.</i>"
        : '<i>Available across this group.</i>'
  );
  return lines.join('\n');
}

/** The one-line form `/context` uses alongside the document sections. */
export function buildContextRepoLine(view: RepoScopeView): string {
  if (view.status === 'none') return '<b>GitHub:</b> <i>— not connected</i>';
  if (view.status === 'pending_confirmation') return '<b>GitHub:</b> <i>— awaiting admin confirmation</i>';
  if (view.status === 'suspended') return '<b>GitHub:</b> <i>— installation suspended</i>';
  if (view.repos.length === 0) return '<b>GitHub:</b> <i>— none linked here</i>';

  const names = view.repos
    .map((repo) => `${repo.pinned ? '📌 ' : ''}<code>${esc(repo.shortName)}</code>`)
    .join(', ');
  const suffix = view.isPinned ? ' <i>(pinned to this topic)</i>' : '';
  return `<b>GitHub:</b> ${names}${suffix}`;
}

/** Replies for the cases where a pin change is refused. */
export const REPOS_ANONYMOUS_ADMIN =
  'Turn off anonymous admin mode to change repo pins — I cannot check admin rights for a message sent as the group.';

export const REPOS_NOT_ADMIN = 'Only a group admin can change which repositories this topic uses.';

export const REPOS_NOT_IN_TOPIC =
  'Pins only apply inside a topic. Here I use every repository linked to this group.';

export function buildUnknownReposReply(unknown: string[], available: ScopedRepo[]): string {
  const missing = unknown.map((name) => `<code>${esc(name)}</code>`).join(', ');
  if (available.length === 0) {
    return `I don't know ${missing}, and no repositories are linked to this group yet.`;
  }
  const choices = available.map((repo) => `<code>${esc(repo.shortName)}</code>`).join(', ');
  return `I don't know ${missing}. Linked here: ${choices}.`;
}

export function buildReposHelp(command: ReposCommand & { action: 'help' }): string {
  const lead =
    command.reason === 'missing_names'
      ? `Which repository? <code>/repos ${command.subcommand} &lt;name&gt;</code>`
      : `I don't know <code>${esc(command.subcommand || '')}</code>.`;
  return [
    lead,
    '',
    '<code>/repos</code> — what I can read here',
    '<code>/repos pin &lt;name&gt; …</code> — narrow this topic to those repositories (admins)',
    '<code>/repos unpin &lt;name&gt;</code> — remove a pin (admins)',
    '<code>/repos clear</code> — go back to the group\'s repositories (admins)',
  ].join('\n');
}
