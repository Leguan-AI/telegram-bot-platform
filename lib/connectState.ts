/**
 * The `state` the GitHub connect flow round-trips (#21 §2).
 *
 * Its own module, with no database or network imports, so the routes and the unit tests
 * can both use it without dragging a connection pool along.
 *
 * Normally the state is just the single-use token. When the callback has to take the owner
 * through the OAuth authorization hop — because the install leg returned no `code` — it
 * re-sends the state with the installation id appended, since that second redirect comes
 * back without one.
 *
 * The installation id carried here is untrusted, exactly as the URL parameter always was:
 * the owner check verifies it against the authorizing user's own `/user/installations`
 * before anything is written. The suffix also marks the second hop, so a missing code after
 * it is a real failure rather than a reason to redirect again.
 */

/** As minted by mint_github_connect_token: 26 Crockford base32 characters. */
const TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const STATE_SEPARATOR = '~';

export function isConnectTokenShape(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export interface ParsedConnectState {
  token: string;
  /** Present only on the second hop. */
  installationId: number | null;
}

export function buildConnectState(token: string, installationId: number): string {
  return `${token}${STATE_SEPARATOR}${installationId}`;
}

export function parseConnectState(raw: string): ParsedConnectState | null {
  const [token, suffix, ...rest] = raw.split(STATE_SEPARATOR);
  if (rest.length > 0) return null;
  if (!isConnectTokenShape(token)) return null;

  if (suffix === undefined) {
    return { token, installationId: null };
  }

  if (!/^[0-9]+$/.test(suffix)) return null;
  const installationId = Number(suffix);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;

  return { token, installationId };
}
