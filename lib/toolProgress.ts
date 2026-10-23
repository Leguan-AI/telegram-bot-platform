/**
 * The one-line "what the bot is doing right now" status, from a tool-loop hop (#21 §7).
 *
 * A repository answer can spend most of a 90-second budget before a word of it appears,
 * and a typing indicator does not say whether anything is happening. This turns a hop's
 * tool calls into a line for the status message runWithStatus is already editing.
 *
 * Everything here treats the tool input as hostile, because it is: the fields arrive from
 * the model, which has just been reading repository files that may themselves contain
 * text aimed at us. Three rules follow from that.
 *
 *  1. Repository names are never echoed, only resolved. A name is matched against the
 *     repositories in scope and shown as the scope's own spelling, so a model that asks
 *     for `acme/private-payroll` cannot make that string appear in a group chat.
 *  2. Search queries are never shown. A path has a shape worth checking and is useful to
 *     read; a query is unbounded free text, and "🔍 Searching …" plus someone else's
 *     sentence is how a status line becomes a billboard.
 *  3. Paths go through normalizeRepoPath — the same check the tools use — and are then
 *     stripped of characters that reorder a line rather than appear in it, and shortened
 *     in the middle. The status message carries no entities and no parse mode (see
 *     editMessageText), so there is no markup to escape, but plain text is still a line
 *     someone reads: a path may not forge a second one.
 */

import { normalizeRepoPath } from '@/lib/sensitiveFiles';
import { matchRepoName, type ScopedRepoRef } from '@/lib/repoToolsTypes';

/** One tool call, as the loop's onProgress hook reports it. */
export interface ProgressCall {
  name: string;
  input: Record<string, unknown>;
}

/** Longest path shown before the middle is elided. Keeps the line readable on a phone. */
const MAX_PATH_CHARS = 54;

/**
 * Bidi overrides and zero-width characters: legal in a filename, and invisible or
 * line-reordering when rendered. `src/‮gnp.exe` reads as `src/exe.png` with one of these.
 */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * The status line for a hop, or null when there is nothing worth saying — an unrecognised
 * tool name, or no calls. Null means "leave the status message as it is", never "blank it".
 */
export function formatToolProgress(calls: ProgressCall[], repos: ScopedRepoRef[]): string | null {
  const [first, ...rest] = calls;
  if (!first) return null;

  const line = describe(first, repos);
  if (!line) return null;

  // The extra calls are not described: a hop that reads four files would otherwise need
  // four lines, and the count is the part that tells the user why this is taking a while.
  return rest.length > 0 ? `${line} (+${rest.length} more)` : line;
}

function describe(call: ProgressCall, repos: ScopedRepoRef[]): string | null {
  const scope = repos.map((repo) => repo.fullName);
  const named = typeof call.input.repo === 'string' ? call.input.repo : undefined;
  // Unresolved is left out rather than guessed at. The call is about to fail with
  // "I cannot see a repository called …", so naming nothing is the honest line.
  const repo = slugOf(matchRepoName(named, scope));
  const path = pathOf(call.input.path);

  switch (call.name) {
    case 'read_file':
      if (path && repo) return `📖 Reading ${repo}/${path}…`;
      if (path) return `📖 Reading ${path}…`;
      return '📖 Reading a file…';

    case 'list_tree':
      if (path && repo) return `📂 Listing ${repo}/${path}…`;
      if (path) return `📂 Listing ${path}…`;
      if (repo) return `📂 Listing ${repo}…`;
      return '📂 Listing files…';

    case 'search_code':
      if (repo) return `🔍 Searching ${repo}…`;
      // No repo given means every repository in scope (see searchCode), which is worth
      // saying — it is the slowest call and the one most likely to hit a rate limit.
      if (repos.length > 1) return `🔍 Searching ${repos.length} repositories…`;
      return '🔍 Searching the code…';

    default:
      return null;
  }
}

/** `owner/name` → `name`, which is what people call their repositories (matches /context). */
function slugOf(fullName: string | null): string | null {
  if (!fullName) return null;
  const slug = fullName.slice(fullName.indexOf('/') + 1);
  return slug === '' ? null : slug;
}

/**
 * A displayable path, or null. Normalisation does the security work — control characters,
 * backslashes, absolute paths, `..` and layered percent-escapes are all refused there —
 * and this adds only what display needs.
 */
function pathOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;

  const normalized = normalizeRepoPath(raw);
  if (!normalized.ok || normalized.path === '') return null;

  const cleaned = normalized.path.replace(INVISIBLE, '');
  if (cleaned === '') return null;

  return shorten(cleaned);
}

/**
 * Elides the middle, keeping the filename: the end of a path says more than its middle,
 * and `…/components/Button.tsx` is the part a reader recognises.
 */
function shorten(path: string): string {
  // Spread, so a character outside the BMP is not cut in half into two lone surrogates.
  const chars = [...path];
  if (chars.length <= MAX_PATH_CHARS) return path;

  const tail = Math.ceil((MAX_PATH_CHARS - 1) * 0.7);
  const head = MAX_PATH_CHARS - 1 - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
