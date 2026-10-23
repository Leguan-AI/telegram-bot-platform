/**
 * The answer-time repository tools (#21 §6).
 *
 * One session per answer. It owns everything that must be shared across the tool calls in
 * that answer and must not outlive it:
 *
 *   * **one downscoped token**, minted for exactly the in-scope repository ids with
 *     `contents` + `metadata` — never the App's `members` permission. GitHub enforces the
 *     scope, so whatever the model asks for, it cannot reach a repository that was pinned
 *     away or never linked;
 *   * **one pinned commit per repository**, resolved once, so every read in an answer sees
 *     the same tree;
 *   * **one recursive tree per repository**, which serves every list_tree call and
 *     pre-screens read_file;
 *   * **a result memory**, so a model repeating itself costs nothing;
 *   * **a content budget** and **per-bucket rate-limit short-circuits**.
 *
 * Nothing here is persisted. The token, the trees and the memory live as long as the
 * session object and no longer.
 */

import {
  METADATA_ONLY_PERMISSIONS,
  READ_ONLY_REPO_PERMISSIONS,
  mintInstallationToken,
} from '@/lib/githubAppToken';
import {
  SENSITIVE_FILE_REPLY,
  INVALID_PATH_REPLY,
  filterListing,
  isNameBlocked,
  normalizeRepoPath,
} from '@/lib/sensitiveFiles';
import {
  DEFAULT_LIMITS,
  matchRepoName,
  type RateBucket,
  type ReadRecord,
  type RepoToolLimits,
  type ScopedRepoRef,
  type ToolResult,
} from '@/lib/repoToolsTypes';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  size?: number;
}

interface RepoState {
  ref: ScopedRepoRef;
  sha?: string;
  tree?: { entries: TreeEntry[]; truncated: boolean };
}

const BUDGET_SPENT: ToolResult = {
  content: 'I have reached the amount of repository content I can read for one answer.',
  isError: true,
};

const RATE_LIMITED = 'GitHub is rate-limiting these requests. I could not read any more from the repository.';

export class RepoToolSession {
  private token: string | null = null;
  private readonly repos = new Map<string, RepoState>();
  private readonly limits: RepoToolLimits;
  /**
   * tool + normalised arguments -> what was returned, and whether it carried repository
   * content. §7 treats the two differently on a repeat: content becomes a pointer, because
   * it is already in the model's context, while a notice ("not found", the sensitive-file
   * reply, a binary description) is simply repeated.
   */
  private readonly memory = new Map<string, { result: ToolResult; kind: 'content' | 'notice' }>();
  /** Keys whose first failure was transient; one real retry is allowed (§7 rule 6). */
  private readonly transientOnce = new Set<string>();
  private readonly exhausted = new Set<RateBucket>();
  private readonly reads: ReadRecord[] = [];
  private bytesReturned = 0;

  constructor(
    private readonly input: {
      installationId: number;
      repos: ScopedRepoRef[];
      limits?: Partial<RepoToolLimits>;
    }
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...(input.limits || {}) };
    for (const ref of input.repos) {
      this.repos.set(ref.fullName.toLowerCase(), { ref });
    }
  }

  /**
   * Dispatches one model-issued tool call.
   *
   * The arguments are whatever the model sent, so each field is checked for its type
   * rather than cast: a `path` that arrives as a number or an object would otherwise
   * reach normalizeRepoPath, which expects a string. An unknown tool name is answered,
   * not thrown — the loop needs a tool_result for every tool_use.
   */
  async run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const repo = typeof input.repo === 'string' ? input.repo : undefined;

    switch (name) {
      case 'list_tree':
        return this.listTree({
          repo,
          path: typeof input.path === 'string' ? input.path : undefined,
          depth: typeof input.depth === 'number' && Number.isFinite(input.depth) ? input.depth : undefined,
        });

      case 'read_file':
        if (typeof input.path !== 'string') {
          return { content: 'read_file needs a `path`.', isError: true };
        }
        return this.readFile({ repo, path: input.path });

      case 'search_code':
        if (typeof input.query !== 'string') {
          return { content: 'search_code needs a `query`.', isError: true };
        }
        return this.searchCode({ repo, query: input.query });

      default:
        return { content: `There is no tool called ${JSON.stringify(name)}.`, isError: true };
    }
  }

  /** Files actually read, for the provenance footer the server builds (§9). */
  getReads(): ReadRecord[] {
    return [...this.reads];
  }

  /** Repository content returned so far, across every call in this answer. */
  getBytesReturned(): number {
    return this.bytesReturned;
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /**
   * Structure, served from the one recursive tree held for this answer. Arguments are a
   * path and a depth; neither reaches GitHub after the first call for that repository.
   */
  async listTree(args: { repo?: string; path?: string; depth?: number }): Promise<ToolResult> {
    const repo = this.resolveRepo(args.repo);
    if (!repo) return this.unknownRepo(args.repo);

    const root = args.path ? normalizeRepoPath(args.path) : { ok: true as const, path: '' };
    if (!root.ok) return { content: INVALID_PATH_REPLY, isError: true };

    const depth = clamp(args.depth ?? 1, 1, this.limits.maxTreeDepth);
    const key = memoryKey('list_tree', repo.ref.fullName, root.path, String(depth));
    const remembered = this.recall(key);
    if (remembered) return remembered;
    if (this.budgetSpent()) return BUDGET_SPENT;

    const tree = await this.loadTree(repo);
    if ('error' in tree) return this.remember(key, tree.error);

    const prefix = root.path ? `${root.path}/` : '';
    // Name-blocked entries go before anything counts them, so neither the listing nor the
    // "…N more" marker can reveal that they exist (§6 rule 6).
    const visible = filterListing(
      tree.value.entries.filter((entry) => {
        if (prefix && !entry.path.startsWith(prefix)) return false;
        if (!prefix && entry.path === '') return false;
        const relative = entry.path.slice(prefix.length);
        if (relative === '') return false;
        return relative.split('/').length <= depth;
      }),
      (entry) => entry.path
    );

    if (visible.length === 0) {
      return this.remember(key, {
        content: root.path ? `No entries under ${root.path}.` : 'This repository appears to be empty.',
      });
    }

    const shown = visible.slice(0, this.limits.maxTreeEntries);
    const lines = shown.map((entry) => formatTreeEntry(entry, prefix));
    if (visible.length > shown.length) {
      lines.push(`…${visible.length - shown.length} more entries`);
    }
    if (tree.value.truncated) {
      lines.push('(GitHub truncated this repository’s tree, so the listing may be incomplete.)');
    }

    const listing = lines.join('\n');
    this.bytesReturned += listing.length;
    return this.remember(key, { content: listing }, 'content');
  }

  /**
   * One file at the pinned commit.
   *
   * Order matters: the name check runs **before** the tree is consulted, so a name-blocked
   * path gets the sensitive-file reply rather than "not found" — the reply must not depend
   * on whether the file exists (§6 rule 6).
   */
  async readFile(args: { repo?: string; path: string }): Promise<ToolResult> {
    const repo = this.resolveRepo(args.repo);
    if (!repo) return this.unknownRepo(args.repo);

    const normalized = normalizeRepoPath(args.path || '');
    if (!normalized.ok) return { content: INVALID_PATH_REPLY, isError: true };

    if (isNameBlocked(normalized.path)) {
      return { content: SENSITIVE_FILE_REPLY };
    }

    const key = memoryKey('read_file', repo.ref.fullName, normalized.path);
    const remembered = this.recall(key);
    if (remembered) return remembered;

    // The tree pre-screens: a complete one answers "not found", "that is a directory",
    // symlink and submodule without a GitHub call.
    const tree = await this.loadTree(repo);
    if ('error' in tree) return this.remember(key, tree.error);

    if (!tree.value.truncated) {
      const entry = tree.value.entries.find((e) => e.path === normalized.path);
      if (!entry) {
        return this.remember(key, { content: `No file at ${normalized.path} in ${repo.ref.fullName}.` });
      }
      if (entry.type === 'tree') {
        return this.remember(key, { content: `${normalized.path} is a directory. Use list_tree for its contents.` });
      }
      if (entry.type === 'commit') {
        return this.remember(key, { content: `${normalized.path} is a submodule, which I do not follow.` });
      }
      if (entry.mode === '120000') {
        return this.remember(key, { content: `${normalized.path} is a symlink, which I do not follow.` });
      }
    }

    if (this.budgetSpent()) return this.remember(key, BUDGET_SPENT);

    const fetched = await this.getContents(repo, normalized.path);
    if ('error' in fetched) return this.remember(key, fetched.error);

    const file = fetched.value;
    if (file.kind === 'absent') {
      return this.remember(key, { content: `No file at ${normalized.path} in ${repo.ref.fullName}.` });
    }
    if (file.kind === 'lfs') {
      return this.remember(key, { content: `${normalized.path} is stored in Git LFS, so its contents are not available here.` });
    }
    if (file.kind === 'binary') {
      return this.remember(key, {
        content: `${normalized.path} is a binary file (${file.size} bytes); I can only report its name and size.`,
      });
    }

    // No content inspection here: the policy blocks by name (see lib/sensitiveFiles.ts for
    // why content regexes were measured and dropped — they blocked documentation far more
    // often than secrets). The name check above already ran, before anything that could
    // reveal whether the file exists.
    const budgetLeft = Math.max(0, this.limits.maxAnswerBytes - this.bytesReturned);
    const allowance = Math.min(this.limits.maxFileBytes, budgetLeft);
    const truncated = file.text.length > allowance;
    const body = truncated ? file.text.slice(0, allowance) : file.text;

    this.bytesReturned += body.length;
    this.reads.push({ repoFullName: repo.ref.fullName, path: normalized.path });

    const content = truncated
      ? `${body}\n\n… truncated: ${normalized.path} is ${file.text.length} characters, showing the first ${body.length}.`
      : body;

    return this.remember(key, { content }, 'content');
  }

  /**
   * Code search, scoped by us rather than by the model (§6, R3-B1).
   *
   * Every qualifier the model supplies is stripped — `repo:`, `org:`, `user:` and the rest
   * — and the in-scope repositories are appended from our own list. Results are then
   * filtered by repository id as well, so a qualifier we failed to anticipate still cannot
   * widen the search. The downscoped token is the third layer.
   */
  async searchCode(args: { repo?: string; query: string }): Promise<ToolResult> {
    const scope = args.repo ? [this.resolveRepo(args.repo)] : [...this.repos.values()];
    if (scope.some((repo) => !repo)) return this.unknownRepo(args.repo);
    const repos = scope as RepoState[];

    const stripped = stripSearchQualifiers(args.query || '');
    if (stripped === '') {
      return { content: 'Give me something to search for — qualifiers alone are not a query.', isError: true };
    }

    const key = memoryKey('search_code', repos.map((r) => r.ref.fullName).join(','), stripped);
    const remembered = this.recall(key);
    if (remembered) return remembered;
    if (this.budgetSpent()) return BUDGET_SPENT;

    if (this.exhausted.has('search')) {
      return { content: RATE_LIMITED, isError: true };
    }

    const scopedQuery = `${stripped} ${repos.map((repo) => `repo:${repo.ref.fullName}`).join(' ')}`;
    const response = await this.request(
      `${GITHUB_API}/search/code?q=${encodeURIComponent(scopedQuery)}&per_page=${this.limits.maxSearchResults}`,
      'search',
      { Accept: 'application/vnd.github.text-match+json' }
    );
    if ('error' in response) return this.remember(key, response.error);

    const data = (await response.value.json()) as {
      items?: Array<{ path: string; repository?: { id?: number }; text_matches?: Array<{ fragment?: string }> }>;
    };

    const allowedIds = new Set(repos.map((repo) => repo.ref.repoId));
    const hits: string[] = [];
    for (const item of data.items || []) {
      // Defence in depth, and it must fail CLOSED: a hit whose repository we cannot
      // identify is dropped, not kept. An installation token can search public code
      // anywhere, so "unknown id" is exactly the shape a leak would take.
      const repoId = item.repository?.id;
      if (typeof repoId !== 'number' || !allowedIds.has(repoId)) continue;
      if (isNameBlocked(item.path)) continue;

      const fragment = item.text_matches?.[0]?.fragment || '';

      hits.push(fragment ? `${item.path}\n    ${fragment.trim().split('\n').join('\n    ')}` : item.path);
      if (hits.length >= this.limits.maxSearchResults) break;
    }

    // Our own count after filtering, never GitHub's total_count (§6 rule 6).
    const content =
      hits.length === 0
        ? `No matches for that search in ${repos.map((r) => r.ref.fullName).join(', ')}.`
        : `${hits.length} match${hits.length === 1 ? '' : 'es'}:\n\n${hits.join('\n\n')}`;

    this.bytesReturned += content.length;
    return this.remember(key, { content }, hits.length > 0 ? 'content' : 'notice');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private budgetSpent(): boolean {
    return this.bytesReturned >= this.limits.maxAnswerBytes;
  }

  private resolveRepo(name?: string): RepoState | null {
    // Accepts the short name too; the model sees owner/name but people type the tail.
    // matchRepoName holds the rule, shared with the progress line so the repository we
    // say we are reading is always the one we read.
    const matched = matchRepoName(name, [...this.repos.values()].map((repo) => repo.ref.fullName));
    return matched ? this.repos.get(matched.toLowerCase()) ?? null : null;
  }

  private unknownRepo(name?: string): ToolResult {
    const choices = [...this.repos.values()].map((r) => r.ref.fullName).join(', ');
    return {
      content: name
        ? `I cannot see a repository called ${name} here. Available: ${choices}.`
        : `Say which repository you mean. Available: ${choices}.`,
      isError: true,
    };
  }

  /** The downscoped token for this answer, minted at most once. */
  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    const repositoryIds = [...this.repos.values()].map((repo) => repo.ref.repoId);
    const token = await mintInstallationToken({
      installationId: this.input.installationId,
      repositoryIds,
      permissions: { ...READ_ONLY_REPO_PERMISSIONS },
    });
    this.token = token.token;
    return this.token;
  }

  /** The commit every read in this answer is pinned to, resolved once per repository. */
  private async getSha(repo: RepoState): Promise<{ value: string } | { error: ToolResult }> {
    if (repo.sha) return { value: repo.sha };

    const response = await this.request(
      `${GITHUB_API}/repos/${repo.ref.fullName}/commits/${encodeURIComponent(repo.ref.defaultBranch)}`,
      'rest'
    );
    if ('error' in response) return response;

    const data = (await response.value.json()) as { sha?: string };
    if (!data.sha) {
      return { error: { content: `I could not read ${repo.ref.fullName} just now.`, isError: true } };
    }
    repo.sha = data.sha;
    return { value: data.sha };
  }

  /** One recursive tree per repository per answer (§6). */
  private async loadTree(
    repo: RepoState
  ): Promise<{ value: { entries: TreeEntry[]; truncated: boolean } } | { error: ToolResult }> {
    if (repo.tree) return { value: repo.tree };

    const sha = await this.getSha(repo);
    if ('error' in sha) return sha;

    const response = await this.request(
      `${GITHUB_API}/repos/${repo.ref.fullName}/git/trees/${sha.value}?recursive=1`,
      'rest'
    );
    if ('error' in response) return response;

    const data = (await response.value.json()) as {
      tree?: Array<{ path?: string; type?: string; mode?: string; size?: number }>;
      truncated?: boolean;
    };

    const entries: TreeEntry[] = [];
    for (const raw of data.tree || []) {
      if (!raw.path || !raw.type) continue;
      entries.push({
        path: raw.path,
        type: raw.type === 'tree' ? 'tree' : raw.type === 'commit' ? 'commit' : 'blob',
        mode: raw.mode || '',
        size: raw.size,
      });
    }

    repo.tree = { entries, truncated: Boolean(data.truncated) };
    return { value: repo.tree };
  }

  private async getContents(
    repo: RepoState,
    path: string
  ): Promise<
    | { value: { kind: 'text'; text: string } | { kind: 'binary'; size: number } | { kind: 'lfs' } | { kind: 'absent' } }
    | { error: ToolResult }
  > {
    const sha = await this.getSha(repo);
    if ('error' in sha) return sha;

    const response = await this.request(
      `${GITHUB_API}/repos/${repo.ref.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha.value}`,
      'rest',
      {},
      [404]
    );
    if ('error' in response) return response;
    if (response.value.status === 404) return { value: { kind: 'absent' } };

    const data = (await response.value.json()) as {
      content?: string;
      encoding?: string;
      size?: number;
      type?: string;
    };

    if (data.type !== 'file' || typeof data.content !== 'string') {
      return { value: { kind: 'absent' } };
    }

    const buffer = Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
    // A NUL byte is the practical test for "not text".
    if (buffer.includes(0)) {
      return { value: { kind: 'binary', size: data.size ?? buffer.length } };
    }

    const text = buffer.toString('utf8');
    if (/^version https:\/\/git-lfs\.github\.com\/spec\//.test(text)) {
      return { value: { kind: 'lfs' } };
    }

    return { value: { kind: 'text', text } };
  }

  /**
   * One GitHub request, with the per-bucket short-circuit from §7 rule 5: after a 403 or
   * 429, everything else in that bucket fails the same way without contacting GitHub.
   */
  private async request(
    url: string,
    bucket: RateBucket,
    extraHeaders: Record<string, string> = {},
    allowStatuses: number[] = []
  ): Promise<{ value: Response } | { error: ToolResult }> {
    if (this.exhausted.has(bucket)) {
      return { error: { content: RATE_LIMITED, isError: true } };
    }

    let token: string;
    try {
      token = await this.getToken();
    } catch (err) {
      console.error('Could not mint a repository token:', err);
      return { error: { content: 'I could not get access to the repository just now.', isError: true } };
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'telegram-bot-platform',
          Authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
      });
    } catch (err) {
      console.warn('Repository request failed:', err);
      return { error: { content: 'I could not reach GitHub just now.', isError: true } };
    }

    // A 429 is always a rate limit. A 403 is only one when GitHub says so — through an
    // exhausted remaining count or a Retry-After — because a permission 403 (an
    // installation suspended mid-answer, say) must not poison the bucket for the rest of
    // the answer, nor be reported to the model as rate-limiting.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    const rateLimited =
      response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null));

    if (rateLimited) {
      this.exhausted.add(bucket);
      console.warn(`GitHub ${response.status} on ${bucket}; short-circuiting the rest of this answer.`);
      return { error: { content: RATE_LIMITED, isError: true } };
    }

    if (response.status === 403) {
      console.warn(`GitHub 403 (not a rate limit) for ${url.split('?')[0]}`);
      return { error: { content: 'I am not allowed to read that from the repository.', isError: true } };
    }

    if (!response.ok && !allowStatuses.includes(response.status)) {
      console.warn(`GitHub ${response.status} for ${url.split('?')[0]}`);
      return { error: { content: 'I could not read that from the repository.', isError: true } };
    }

    return { value: response };
  }

  // -------------------------------------------------------------------------
  // Per-answer result memory (§7 rule 6)
  // -------------------------------------------------------------------------

  private recall(key: string): ToolResult | null {
    const hit = this.memory.get(key);
    if (!hit) return null;

    if (hit.kind === 'content') {
      return { content: 'You already received this earlier in this answer; see the earlier result.' };
    }
    return hit.result;
  }

  private remember(key: string, result: ToolResult, kind: 'content' | 'notice' = 'notice'): ToolResult {
    // A transient failure is not remembered the first time: one identical retry gets a real
    // request, and only a second failure sticks.
    if (result.isError && !this.transientOnce.has(key) && isTransient(result)) {
      this.transientOnce.add(key);
      return result;
    }
    this.memory.set(key, { result, kind });
    return result;
  }
}

function isTransient(result: ToolResult): boolean {
  return result.content.startsWith('I could not reach GitHub') || result.content.startsWith('I could not read that');
}

function memoryKey(...parts: string[]): string {
  return parts.join('\u0000');
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatTreeEntry(entry: TreeEntry, prefix: string): string {
  const relative = entry.path.slice(prefix.length);
  if (entry.type === 'tree') return `dir   ${relative}/`;
  if (entry.type === 'commit') return `sub   ${relative}`;
  if (entry.mode === '120000') return `link  ${relative}`;
  return `file  ${relative}${entry.size !== undefined ? ` (${entry.size} bytes)` : ''}`;
}

/**
 * Strips every GitHub search qualifier from a model-supplied query (#21 §6, R3-B1).
 *
 * The first version matched a qualifier only at the start of the query or after
 * whitespace, which left several ways through — all of them verified against this
 * function, not imagined:
 *
 *     foo (repo:evil/x OR bar)   → untouched: `(` is not whitespace
 *     foo +repo:evil/x           → untouched: `+` is not whitespace
 *     owner:evil thing           → untouched: `owner` was not in the key list
 *     repo:"quoted value" rest   → half-stripped, leaving a dangling quote
 *
 * That matters because an installation token can search **public** code anywhere, so a
 * surviving `repo:` or `org:` reaches repositories nobody shared with us. The repository-id
 * filter is the layer behind this one; neither should be load-bearing alone.
 *
 * So: qualifiers are matched at any non-word boundary, quoted values are consumed whole,
 * and the boolean grammar goes too. Without that last part a leftover `OR` could make the
 * `repo:` terms we append optional — scoping that the model can switch off is not scoping.
 */
const QUALIFIER_KEYS = [
  'repo',
  'repository',
  'org',
  'organization',
  'owner',
  'user',
  'enterprise',
  'fork',
  'is',
  'in',
  'path',
  'language',
  'lang',
  'filename',
  'extension',
  'size',
  'created',
  'pushed',
  'updated',
  'stars',
  'forks',
  'topic',
  'archived',
  'mirror',
  'license',
  'symbol',
  'content',
  'base',
  'head',
  'author',
  'committer',
  'merge',
  'state',
  'label',
];

/** `key:"quoted value"` or `key:bare-value`, anywhere it appears, optionally negated. */
const QUALIFIER_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])[-+]?(${QUALIFIER_KEYS.join('|')}):("[^"]*"|\\S*)`,
  'gi'
);

/**
 * Parentheses and boolean operators, which would let the model re-structure our query.
 *
 * Lookarounds rather than consumed delimiters: matching the spaces around an operator
 * means two adjacent ones overlap, and the second survives. `a OR OR b` came out as
 * `a OR b` — still enough to put an OR in front of the repo: terms we append, which is
 * the whole point of removing them. Zero-width boundaries let each match independently.
 */
const BOOLEAN_GRAMMAR = /(?<=^|\s)(?:AND|OR|NOT)(?=\s|$)|[()]/g;

export function stripSearchQualifiers(query: string): string {
  if (typeof query !== 'string') return '';

  let cleaned = query;
  // Repeat: stripping one qualifier can bring the next up against a boundary that only
  // now matches (`repo:a repo:b` and nested spellings).
  for (let pass = 0; pass < 4; pass++) {
    const next = cleaned.replace(QUALIFIER_PATTERN, '$1 ');
    if (next === cleaned) break;
    cleaned = next;
  }

  // Looped as well as lookaround-based: belt and braces, and consistent with the
  // qualifier pass above.
  for (let pass = 0; pass < 4; pass++) {
    const next = cleaned.replace(BOOLEAN_GRAMMAR, ' ');
    if (next === cleaned) break;
    cleaned = next;
  }

  // Any stray quote left behind would unbalance the query we build.
  cleaned = cleaned.replace(/"/g, ' ');

  return cleaned.replace(/\s+/g, ' ').trim();
}
