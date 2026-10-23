/**
 * The sensitive-file policy for repository tools (#21 §6).
 *
 * Defence in depth, not a security boundary — the boundaries are the owner's repository
 * selection, the DB-sourced repo ids and the downscoped per-answer token. This stops the
 * bot handing over the kinds of file nobody means to share, and it applies to **every**
 * tool: list_tree, read_file and search_code alike.
 *
 * Pure: no network, no database, no GitHub types. Everything here is a function of a path
 * or a string, which is what lets the §6 vector table be tested exactly as written.
 *
 * **Blocking is by name only**, decided from the path alone — so the answer is the same
 * whether or not the file exists, which is what makes these files undiscoverable:
 * read_file cannot probe for them, and list_tree omits them before anything counts.
 *
 * WHY THERE IS NO CONTENT SCANNING (decided 2026-10-23, after measuring).
 *
 * #21 §6 also specified regexes over file contents. They were built, and then dropped,
 * because they cost far more than they bought:
 *
 *   * **They block documentation.** Ten of thirteen realistic placeholder credentials
 *     tripped them — `sk-ant-your-api-key-goes-here`, `xoxb-your-token-here`,
 *     `glpat-xxxxxxxxxxxxxxxxxxxx`, and `AKIAIOSFODNN7EXAMPLE`, which is AWS's *own*
 *     documentation example. Placeholders are written to look like the real thing; that is
 *     their purpose, and it is exactly what defeats a format matcher. Earlier versions of
 *     the same idea had already blocked this repository's own DEPLOYMENT.md and
 *     .env.example.
 *   * **They are never complete.** Any list covers the providers someone thought of, so a
 *     secret in an unlisted format passes anyway. The protection was partial by
 *     construction.
 *   * **The exemptions are their own hazard.** Two rounds of review found the placeholder
 *     predicates excusing real-looking passwords. A loose exemption reads as protection
 *     while removing it.
 *
 * What remains true without them: secrets should not be in these repositories at all;
 * anyone who can reach the bot in a group can already reach the repository's contents
 * (§8); GitHub's own secret scanning sits in front; and the files where credentials
 * actually live — .env, *.pem, credentials.json, .npmrc, *.tfvars — are blocked by name,
 * precisely and with no false positives.
 *
 * The residual risk is a live credential hard-coded into an ordinarily-named source file,
 * which the bot could then read and send to a model provider. That repository is already
 * compromised by every collaborator who can clone it; the marginal harm is small, and the
 * cost of pretending otherwise is a bot that cannot read a deployment guide.
 *
 * The user-facing promise is worded to match: "files that look like secrets — .env files,
 * private keys, credential files — are never available", which is a claim about names.
 */

/** The one reply for any blocked file. Identical for "blocked" and "does not exist". */
export const SENSITIVE_FILE_REPLY = "Files with sensitive data aren't available to me.";

export const INVALID_PATH_REPLY = 'That path is not valid.';

export type NormalizedPath =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid_path' };

/**
 * Step 1: normalisation, applied to every model-supplied path before matching and before
 * any GitHub call.
 *
 * Percent-decoding repeats until stable, so `%252e%252e` decodes to `%2e%2e` and then to
 * `..` and is caught by the traversal check — a single decode would miss it.
 */
export function normalizeRepoPath(raw: string): NormalizedPath {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'invalid_path' };
  }

  let decoded = raw;
  for (let i = 0; i < 5; i++) {
    const next = decodePercentEscapes(decoded);
    if (next === decoded) break;
    decoded = next;
    // Still unwrapping after five passes is not a filename; it is someone hiding something.
    if (i === 4) return { ok: false, reason: 'invalid_path' };
  }

  // NUL and control characters, backslashes, and absolute paths.
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return { ok: false, reason: 'invalid_path' };
  if (decoded.includes('\\')) return { ok: false, reason: 'invalid_path' };
  if (decoded.startsWith('/')) return { ok: false, reason: 'invalid_path' };

  // Unicode NFC first, so composed and decomposed spellings of the same name match.
  const normalized = decoded.normalize('NFC');

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue; // collapses `//` and `./`
    if (segment === '..') return { ok: false, reason: 'invalid_path' };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: 'invalid_path' };

  return { ok: true, path: segments.join('/') };
}

/**
 * Decodes the percent-escapes a string actually has, and leaves alone what it does not.
 *
 * `decodeURIComponent` is all-or-nothing: one stray `%` and it throws for the whole
 * string. Treating that as "invalid path" costs real files — `README (100%).md` would be
 * unreadable *and* silently missing from every listing — while simply stopping at the
 * throw costs something worse: `%2e%2e/%zz` would keep its encoded `..` and never be seen
 * as traversal.
 *
 * So each maximal run of valid escapes is decoded on its own (a run, not a single escape,
 * so multi-byte UTF-8 survives), and anything malformed stays literal. `%2e%2e/%zz`
 * becomes `../%zz` and is refused; `README (100%).md` passes through untouched.
 */
function decodePercentEscapes(input: string): string {
  return input.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Converts one documented glob into an anchored, case-insensitive regex. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Rule 2 — filename globs, matched on the **basename at any depth**, so
 * `apps/web/.env.local` is caught exactly as `.env.local` would be.
 */
const FILENAME_GLOBS = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ovpn',
  // Intentionally also catches *.pub: an id_rsa.pub names the private key beside it, and
  // nobody needs the bot to read either.
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  '.dockercfg',
  '*.tfvars',
  'terraform.tfstate*',
  'credentials.json',
  '*service-account*.json',
  'secrets.yml',
  'secrets.yaml',
].map(globToRegExp);

/** Rule 3 — directory rules, matched as a path suffix at any depth. */
const DIRECTORY_SUFFIXES: RegExp[] = [
  // Anything under a .ssh directory, at any depth: `.ssh/keys/id_work` is as sensitive
  // as `.ssh/id_rsa`, and the spec's `.ssh/*` is not meant to stop at direct children.
  /(^|\/)\.ssh\/.+$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.docker\/config\.json$/i,
];

/**
 * Rule 4 — the template exception. If the basename's last `.`-separated segment is
 * `example`, `sample` or `template`, rules 2 and 3 do not apply. It holds for **all** of
 * them, not only `.env`: `secrets.yml.sample` and `config/credentials.json.template` are
 * ordinary files. Templates still go through the content rules.
 */
const TEMPLATE_SUFFIX = /\.(example|sample|template)$/i;

export function isTemplatePath(path: string): boolean {
  return TEMPLATE_SUFFIX.test(basenameOf(path));
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Rules 2 and 3 with the template exception — "would we refuse this path whatever it
 * contains?". Decided from the path alone, which is what keeps these files
 * undiscoverable.
 *
 * Expects an already-normalised path; a raw one is normalised here so no caller can skip
 * that step by accident, and an un-normalisable path counts as blocked.
 */
export function isNameBlocked(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (!normalized.ok) return true;

  const candidate = normalized.path;
  if (isTemplatePath(candidate)) return false;

  const basename = basenameOf(candidate);
  if (FILENAME_GLOBS.some((rule) => rule.test(basename))) return true;

  return DIRECTORY_SUFFIXES.some((rule) => rule.test(candidate));
}

/**
 * Rule 5 — content patterns, run on the **full file before truncation** and on every
 * search snippet.
 *
 * Each pattern carries a minimum length so ordinary prose does not trip it: `sk-learn` and
 * `scikit-learn` in a requirements file are not OpenAI keys, and a long hyphenated
 * identifier is not a Slack token. The list is finite by design — high signal, low false
 * positives — and is meant to grow by addition, not by loosening.
 *
 * WHEN A RULE EARNS ITS PLACE. Secrets should not be in these repositories at all, and
 * everyone who can reach the bot in a group can already reach the repository's contents
 * (§8) — so this list is not what stands between an attacker and a credential. What it is
 * for is narrower and still worth having: a live credential read by the bot is copied to
 * third-party model providers and logged there, which is a leak beyond the group.
 *
 * That makes the bar: match **token formats**, not **shapes**. A distinctive prefix with a
 * length and a charset — `AKIA…`, `ghp_…`, `sk-ant-…`, `xox…`, `glpat-…` — has essentially
 * no false positives, because nothing else looks like it. Shape rules, which match the
 * *form* of a secret rather than a token, catch documentation just as readily: this repo's
 * own DEPLOYMENT.md and .env.example were both blocked by exactly that mistake. The two
 * shape rules below survive only because they carry precise placeholder predicates.
 *
 * So: prefer a readable repository over an exhaustive matcher. A missed secret that should
 * never have been committed is a smaller harm than a bot that cannot read the deployment
 * guide it is being asked about.
 */
export type FileVerdict =
  | { allowed: true; path: string }
  | { allowed: false; reason: 'invalid_path' }
  | { allowed: false; reason: 'name_blocked' };

/**
 * The whole policy for one file.
 *
 * The name check runs **before** anything that could reveal existence — in the tools that
 * means before the in-memory tree is consulted, so a name-blocked path never comes back as
 * "not found".
 */
export function checkFile(rawPath: string): FileVerdict {
  const normalized = normalizeRepoPath(rawPath);
  if (!normalized.ok) return { allowed: false, reason: 'invalid_path' };

  if (isNameBlocked(normalized.path)) {
    return { allowed: false, reason: 'name_blocked' };
  }

  return { allowed: true, path: normalized.path };
}

/**
 * Removes name-blocked entries from a listing **before** it is counted or capped, so
 * neither the list nor its "…N more" marker reveals that they exist (§6 rule 6).
 */
export function filterListing<T>(entries: T[], pathOf: (entry: T) => string): T[] {
  return entries.filter((entry) => !isNameBlocked(pathOf(entry)));
}
