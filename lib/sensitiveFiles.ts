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
 * Two kinds of block, which behave differently on purpose:
 *   * **name-blocked** — decided from the path alone, so the answer is the same whether or
 *     not the file exists. That is what makes these files *undiscoverable*: read_file
 *     cannot be used to probe for them, and list_tree omits them entirely.
 *   * **content-blocked** — decided by reading the file. Such a file can still appear in a
 *     listing, since listing does not read contents. Reading it returns the same refusal,
 *     which does reveal that it contains something secret-shaped. #21 accepts that: the
 *     alternative is answering "it doesn't exist", which would be a lie.
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
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // A malformed escape is not something to guess at. Note the cost: a real filename
      // containing a stray `%`, such as `README (100%).md`, is refused and therefore
      // invisible to the tools. That is deliberate — failing closed on anything we cannot
      // decode is worth more than reaching an unusual filename — but it is a real gap, not
      // an oversight. Falling back to the raw string would also be safe, since the
      // traversal and control-character checks run on it either way.
      return { ok: false, reason: 'invalid_path' };
    }
    if (next === decoded) break;
    decoded = next;
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
 */
const CONTENT_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'gcp-service-account', pattern: /"type"\s*:\s*"service_account"/ },
  { name: 'aws-access-key', pattern: /(AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { name: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'stripe-live-key', pattern: /[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-project-key', pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  // Alphanumeric only, so long hyphenated identifiers do not match.
  { name: 'openai-legacy-key', pattern: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'slack-token', pattern: /xox[abeoprs]-[A-Za-z0-9-]{10,}/ },

  // Added beyond #21's starting list, which says to grow it as needed. These are the
  // credentials this platform and its neighbours actually handle.
  //
  // A PGP block needs its own rule: the generic one above requires `KEY-----` directly
  // after `PRIVATE`, and a PGP header reads `PRIVATE KEY BLOCK-----`, so it slipped past.
  { name: 'pgp-private-key', pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  // A Telegram bot token — the credential this very repo stores in Vault.
  { name: 'telegram-bot-token', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'xai-key', pattern: /xai-[A-Za-z0-9]{40,}/ },
  { name: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/ },
  // A connection string carrying an inline password, which is how most database
  // credentials actually leak into a repository.
  {
    name: 'db-connection-string',
    pattern: /(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:/@]+:[^\s@]+@/i,
  },
  // A Supabase service-role key is a JWT, which is too generic to match on its own; keying
  // on the role name near one keeps the false-positive rate down. Bounded so the scan
  // cannot backtrack badly.
  { name: 'supabase-service-role', pattern: /service_role[\s\S]{0,200}?eyJ[A-Za-z0-9_-]{20,}/ },
];

/**
 * The name of the first content rule the text trips, or null. The name is for logs — the
 * reply to the model never says which pattern matched, or anything about the contents.
 */
export function findContentSecret(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return null;
}

/** Rule names, for tests and for documenting what the policy covers. */
export function contentRuleNames(): string[] {
  return CONTENT_RULES.map((rule) => rule.name);
}

export type FileVerdict =
  | { allowed: true; path: string }
  | { allowed: false; reason: 'invalid_path' }
  | { allowed: false; reason: 'name_blocked' }
  | { allowed: false; reason: 'content_blocked'; rule: string };

/**
 * The whole policy for one file, in the order §6 requires.
 *
 * The name check runs **before** anything that could reveal existence — in the tools that
 * means before the in-memory tree is consulted, so a name-blocked path never comes back as
 * "not found". Content is checked only once a file has been read, and only if its name was
 * acceptable.
 */
export function checkFile(rawPath: string, content?: string): FileVerdict {
  const normalized = normalizeRepoPath(rawPath);
  if (!normalized.ok) return { allowed: false, reason: 'invalid_path' };

  if (isNameBlocked(normalized.path)) {
    return { allowed: false, reason: 'name_blocked' };
  }

  if (content !== undefined) {
    const rule = findContentSecret(content);
    if (rule) return { allowed: false, reason: 'content_blocked', rule };
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
