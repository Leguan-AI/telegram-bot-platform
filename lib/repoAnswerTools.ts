/**
 * What an answer is told about the repositories, and what it is allowed to ask (#21 §5, §9).
 *
 * Pure: it takes a resolved scope and returns strings and tool definitions. The scope
 * itself comes from resolveRepoScope — the narrow seam — and nothing here widens it. The
 * session that executes the calls (RepoToolSession) holds the downscoped token, so even a
 * tool definition built wrongly could not reach a repository nobody linked.
 *
 * Two §5 rules shape all of this:
 *
 *   * **the structure is not in the prompt.** Only a name and a one-line description per
 *     repository. A directory listing would cost tokens on every message, including the
 *     ones that have nothing to do with code, and would reset the prompt cache on almost
 *     every push;
 *   * **the repository comes from the link, never from the model.** The `repo` argument
 *     exists only as an enum of what is already in scope, and only when there is more
 *     than one to choose between.
 */

import type { CustomToolDefinition } from '@/lib/model';
import type { ScopedRepo } from '@/lib/reposCommand';
import type { RepoScope } from '@/lib/repoScope';
import { DEFAULT_LIMITS, type ReadRecord, type ScopedRepoRef } from '@/lib/repoToolsTypes';
import { stripInvisible } from '@/lib/toolProgress';

/** Longest repository description carried into the prompt. */
const MAX_DESCRIPTION_CHARS = 180;

/**
 * The repositories the tools can actually serve.
 *
 * A repository whose name GitHub would not give us is deliberately excluded: without a
 * name there is no enum value, no API path and no honest descriptor, and a bare `#id` in
 * a prompt invites the model to guess. It still appears in `/repos` and `/context`, where
 * saying "this is linked but unreadable right now" is the useful answer.
 */
export function toolableRepos(scope: RepoScope): ScopedRepoRef[] {
  if (scope.status !== 'active' || scope.installationId === null) return [];

  return scope.repos
    .filter((repo) => repo.defaultBranch && repo.fullName.includes('/') && !repo.fullName.startsWith('#'))
    .map((repo) => ({
      repoId: repo.repoId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch as string,
    }));
}

/**
 * The `<repository>` descriptors for the system prompt, or '' when there are none.
 *
 * Sits next to the `<document>` tags buildContext produces, in the same shape, so the
 * model reads both the same way. A suspended installation says so rather than vanishing:
 * a model that cannot see its repositories listed answers as if the code did not exist,
 * instead of saying it could not look.
 */
export function buildRepositoryDescriptors(scope: RepoScope): string {
  if (scope.repos.length === 0) return '';

  if (scope.status === 'suspended') {
    // Tool definitions are dropped in this state (§5), so the descriptor is all the model
    // gets. It must be enough for it to say "I could not read the code" and stop there.
    return `<repositories unavailable="installation_suspended">
The GitHub connection for this workspace is suspended, so repository contents cannot be read right now. Say so if you are asked about the code; do not guess at its contents and do not claim a file does not exist.
</repositories>`;
  }

  if (scope.status !== 'active') return '';

  const lines = scope.repos
    .filter((repo) => repo.fullName.includes('/') && !repo.fullName.startsWith('#'))
    .map((repo) => {
      const description = describeRepo(repo);
      return description
        ? `<repository name="${xmlAttr(repo.fullName)}" description="${xmlAttr(description)}"/>`
        : `<repository name="${xmlAttr(repo.fullName)}"/>`;
    });

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * The tool set, or [] when nothing is readable.
 *
 * Identical on every call of an answer, because the definitions sit at the start of the
 * cached prefix (§7). The `repo` enum therefore changes only when the scope itself
 * changes — a pin, a link, a disconnect — which is exactly when a cache reset is right.
 */
export function buildRepoToolDefinitions(repos: ScopedRepoRef[]): CustomToolDefinition[] {
  if (repos.length === 0) return [];

  const names = repos.map((repo) => repo.fullName);
  // One repository needs no argument, and leaving it out removes the only field a model
  // could get wrong. With several, the enum is the §5 defence in depth.
  const repoProperty =
    repos.length > 1
      ? {
          repo: {
            type: 'string',
            enum: names,
            description: 'Which repository to look in. Must be one of the listed values.',
          },
        }
      : {};
  const repoRequired = repos.length > 1 ? ['repo'] : [];

  return [
    {
      name: 'list_tree',
      description:
        'List the files and directories at a path in a repository, at the current commit of its default branch. ' +
        'Start here to orient yourself: it is cheap, and it shows the real layout rather than one you assume. ' +
        'Then use search_code to find the relevant code, and read_file only for the files you have identified. ' +
        `Files that look like secrets — .env files, private keys, credential stores — are never listed or readable, ` +
        'so a listing may be missing entries and that does not mean the repository has none.',
      input_schema: {
        type: 'object',
        properties: {
          ...repoProperty,
          path: {
            type: 'string',
            description: 'Directory to list, relative to the repository root. Omit for the root.',
          },
          depth: {
            type: 'integer',
            minimum: 1,
            maximum: DEFAULT_LIMITS.maxTreeDepth,
            description: `How many levels deep to list (default 1, maximum ${DEFAULT_LIMITS.maxTreeDepth}).`,
          },
        },
        required: repoRequired,
      },
    },
    {
      name: 'search_code',
      description:
        'Search the code in the repositories available here for a string or symbol. ' +
        'Use it to find where something is defined or used before reading whole files. ' +
        'Plain terms only: search qualifiers such as repo:, org:, user: or path: are stripped, because the ' +
        'repositories searched are fixed by this workspace and cannot be changed from a query.',
      input_schema: {
        type: 'object',
        properties: {
          ...repoProperty,
          query: {
            type: 'string',
            description: 'What to search for — an identifier, a string literal, a phrase.',
          },
        },
        required: [...repoRequired, 'query'],
      },
    },
    {
      name: 'read_file',
      description:
        'Read one file from a repository, at the current commit of its default branch. ' +
        'Prefer list_tree and search_code first: reading whole files is the most expensive thing you can do, ' +
        'and there is a limit on how much file content one answer may read. ' +
        'Files that look like secrets — .env files, private keys, credential stores — are never available. ' +
        'If you are asked about one, say that sensitive files are not available to you. ' +
        'Never say such a file does not exist, and never guess at what it contains.',
      input_schema: {
        type: 'object',
        properties: {
          ...repoProperty,
          path: {
            type: 'string',
            description: 'Path to the file, relative to the repository root.',
          },
        },
        required: [...repoRequired, 'path'],
      },
    },
  ];
}

/**
 * A short paragraph for the system prompt, next to the descriptors, telling the model the
 * repositories are real and readable. Without it, a model with tools attached and a
 * context document that mentions code tends to answer from the document alone.
 */
export const REPO_GROUNDING = `REPOSITORY ACCESS:
The repositories listed above are connected to this workspace and you can read them with the list_tree, search_code and read_file tools. When a question is about the code — how something works, where something lives, whether something exists — look rather than infer, and say what you read. The repositories are the authority on their own contents; a context document describing them may be out of date. If a tool tells you something is unavailable, say so plainly instead of guessing.`;

/**
 * The §9 provenance footer: the files that were actually read, from the session's own
 * record of its calls.
 *
 * Built on the server, never from model output — a model that claimed to have read a file
 * it did not would otherwise write its own citation. Returned as plain text with no
 * markup: the caller appends it after rendering, so nothing here can affect the entity
 * offsets of the answer above it.
 */
export function buildProvenanceFooter(reads: ReadRecord[], repos: ScopedRepoRef[]): string | null {
  if (reads.length === 0) return null;

  const multiple = repos.length > 1;
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const read of reads) {
    // Several repositories in scope means the path alone is ambiguous; one does not.
    const label = multiple ? `${shortNameOf(read.repoFullName)}/${read.path}` : read.path;
    const clean = stripInvisible(label).replace(/\s+/g, ' ').trim();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    labels.push(clean);
  }

  if (labels.length === 0) return null;
  return `read: ${labels.join(', ')}`;
}

/** `owner/name` → `name`, as the rest of the chat surfaces refer to repositories. */
function shortNameOf(fullName: string): string {
  return fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName;
}

/**
 * GitHub's description, trimmed to one line and capped.
 *
 * It is written by whoever administers the repository, not necessarily by the person who
 * shared it, and it lands in a system prompt — so it is escaped, stripped of anything
 * that could break the attribute or smuggle a line, and short enough that it cannot
 * crowd out the instructions around it.
 */
function describeRepo(repo: ScopedRepo): string | null {
  const raw = typeof repo.description === 'string' ? repo.description : '';
  const oneLine = stripInvisible(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine === '') return null;

  return oneLine.length > MAX_DESCRIPTION_CHARS
    ? `${oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    : oneLine;
}

/** Escapes a value for an XML attribute in the system prompt. */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
