/**
 * GitHub App webhooks — signature check and event interpretation (#21 §4).
 *
 * Pure: no database, no network. The route does the I/O; everything decided here is a
 * function of the raw body and the headers, which is what makes it testable.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
export const GITHUB_EVENT_HEADER = 'x-github-event';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Fail-closed, constant-time check of `X-Hub-Signature-256` over the **raw** body.
 *
 * The signature covers the exact bytes GitHub sent, so the caller must pass the body
 * before any JSON parse-and-restringify — re-serialising changes key order and whitespace
 * and the HMAC stops matching.
 *
 * Both sides are hashed before comparison so timingSafeEqual always sees equal lengths and
 * the comparison cannot leak the expected signature's length. A missing secret or header
 * never matches, the same shape as the Telegram check in lib/webhookAuth.ts.
 */
export function isValidGitHubSignature(
  secret: string | null | undefined,
  rawBody: string,
  provided: string | null | undefined
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  return timingSafeEqual(sha256(expected), sha256(provided));
}

/** What a delivery asks us to do, once the installation is known. */
export type WebhookAction =
  | { kind: 'ignore'; reason: string }
  /** installation.deleted — the owner removed the App. Clear the connection and its links. */
  | { kind: 'delete_installation' }
  /** installation.suspend / unsuspend. */
  | { kind: 'set_suspended'; suspended: boolean }
  /** installation_repositories.removed — unlink those repositories, pins included. */
  | { kind: 'remove_repositories'; repoIds: number[] };

export interface InterpretedWebhook {
  /** Null when the payload carries no installation: nothing we can route. */
  installationId: number | null;
  action: WebhookAction;
  /** Refreshed wherever GitHub tells us, which is most installation-bearing payloads. */
  repositorySelection: 'all' | 'selected' | null;
}

interface RawPayload {
  action?: unknown;
  installation?: { id?: unknown; repository_selection?: unknown } | null;
  repositories_removed?: Array<{ id?: unknown }> | null;
}

function toInstallationId(payload: RawPayload): number | null {
  const id = payload.installation?.id;
  const numeric = typeof id === 'number' ? id : Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function toSelection(payload: RawPayload): 'all' | 'selected' | null {
  const selection = payload.installation?.repository_selection;
  return selection === 'all' || selection === 'selected' ? selection : null;
}

/**
 * Maps a delivery to an action. Anything unrecognised is ignored rather than guessed at —
 * the App subscribes to no events beyond the two GitHub sends every App automatically, so
 * an unknown event means GitHub added something, not that we have work to do.
 */
export function interpretWebhook(event: string, payload: unknown): InterpretedWebhook {
  const body = (payload ?? {}) as RawPayload;
  const installationId = toInstallationId(body);
  const repositorySelection = toSelection(body);
  const action = String(body.action ?? '');

  if (event === 'installation') {
    switch (action) {
      case 'deleted':
        return { installationId, action: { kind: 'delete_installation' }, repositorySelection };
      case 'suspend':
        return { installationId, action: { kind: 'set_suspended', suspended: true }, repositorySelection };
      case 'unsuspend':
        return { installationId, action: { kind: 'set_suspended', suspended: false }, repositorySelection };
      default:
        // created, new_permissions_accepted, … — nothing to apply, but the selection
        // refresh below still runs, which is how "created" keeps our copy honest.
        return {
          installationId,
          action: { kind: 'ignore', reason: `installation.${action || 'unknown'}` },
          repositorySelection,
        };
    }
  }

  if (event === 'installation_repositories') {
    if (action === 'removed') {
      const repoIds: number[] = [];
      for (const repo of body.repositories_removed || []) {
        const id = typeof repo?.id === 'number' ? repo.id : Number(repo?.id);
        if (Number.isSafeInteger(id) && id > 0 && !repoIds.includes(id)) {
          repoIds.push(id);
        }
      }
      return { installationId, action: { kind: 'remove_repositories', repoIds }, repositorySelection };
    }
    // `added` needs no action: links are explicit, so a newly shared repository simply
    // becomes available to link.
    return {
      installationId,
      action: { kind: 'ignore', reason: `installation_repositories.${action || 'unknown'}` },
      repositorySelection,
    };
  }

  return { installationId, action: { kind: 'ignore', reason: `event:${event || 'unknown'}` }, repositorySelection };
}
