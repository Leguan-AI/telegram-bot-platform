/**
 * GitHub connect flow — database capabilities (#21 §2).
 *
 * Server-side only. These call the two `bot_service`-only SECURITY DEFINER functions
 * from 20261022010000_github_app_connect.sql; the /manage half of the flow (mint, list,
 * revoke, confirm, reject) is called straight from the browser as `authenticated`, which
 * is why it has no wrapper here.
 *
 * The functions raise plain-message exceptions (`invalid_token`, `expired`, …). They are
 * re-thrown as ConnectDbError so the routes can branch on a stable reason instead of a
 * Postgres error string.
 */

import { sql } from '@/lib/supabase';
import { isConnectTokenShape } from '@/lib/connectState';
import type { GitHubAccountType } from '@/lib/githubApp';

/** Reasons the DB can refuse a connect. Mirrors the raises in the migration. */
export type ConnectDbReason =
  | 'invalid_token'
  | 'revoked'
  | 'already_consumed'
  | 'expired'
  | 'issuer_not_admin'
  | 'attached_elsewhere'
  | 'entity_slot_taken'
  | 'db_error';

const KNOWN_REASONS: ConnectDbReason[] = [
  'invalid_token',
  'revoked',
  'already_consumed',
  'expired',
  'issuer_not_admin',
  'attached_elsewhere',
  'entity_slot_taken',
];

export class ConnectDbError extends Error {
  constructor(public readonly reason: ConnectDbReason, message?: string) {
    super(message || reason);
    this.name = 'ConnectDbError';
  }
}

function toConnectDbError(err: unknown): ConnectDbError {
  const message = err instanceof Error ? err.message : String(err);
  const match = KNOWN_REASONS.find((reason) => reason === message);
  return new ConnectDbError(match ?? 'db_error', message);
}

export interface ConnectInvitePreview {
  entityId: string;
  entityName: string;
  expiresAt: string;
}

/**
 * Reads an invite for its landing page without consuming it. Also re-checks that the
 * issuing admin is still an entity admin, so a demoted issuer's link dies before the
 * invitee ever reaches GitHub.
 */
export async function peekConnectInvite(code: string): Promise<ConnectInvitePreview> {
  if (!isConnectTokenShape(code)) {
    throw new ConnectDbError('invalid_token', 'Malformed invite token');
  }

  try {
    const rows = await sql<{ result: { entity_id: string; entity_name: string; expires_at: string } }[]>`
      select public.peek_github_connect_invite(${code}) as result
    `;
    const result = rows[0]?.result;
    if (!result) {
      throw new ConnectDbError('invalid_token', 'No invite returned');
    }
    return {
      entityId: result.entity_id,
      entityName: result.entity_name,
      expiresAt: result.expires_at,
    };
  } catch (err) {
    if (err instanceof ConnectDbError) throw err;
    throw toConnectDbError(err);
  }
}

export interface CompleteConnectInput {
  code: string;
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: GitHubAccountType;
  repositorySelection: 'all' | 'selected';
  githubUserId: number;
  githubLogin: string;
}

export interface CompleteConnectResult {
  entityId: string;
  entityName: string;
  kind: 'direct' | 'invite';
  status: 'pending_confirmation' | 'active' | 'suspended';
  outcome: 'connected' | 'pending_confirmation' | 'already_connected';
  accountLogin: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * Consumes the token and records the connection. The entity is taken from the token
 * alone — never from the request — and the owner check has already run at GitHub by the
 * time this is called.
 */
export async function completeGitHubConnect(
  input: CompleteConnectInput
): Promise<CompleteConnectResult> {
  if (!isConnectTokenShape(input.code)) {
    throw new ConnectDbError('invalid_token', 'Malformed connect token');
  }

  try {
    const rows = await sql<{ result: Record<string, string> }[]>`
      select public.complete_github_connect(
        ${input.code},
        ${input.installationId.toString()},
        ${input.accountId.toString()},
        ${input.accountLogin},
        ${input.accountType},
        ${input.repositorySelection},
        ${input.githubUserId.toString()},
        ${input.githubLogin}
      ) as result
    `;
    const result = rows[0]?.result;
    if (!result) {
      throw new ConnectDbError('db_error', 'No result returned from complete_github_connect');
    }
    return {
      entityId: result.entity_id,
      entityName: result.entity_name,
      kind: result.kind as CompleteConnectResult['kind'],
      status: result.status as CompleteConnectResult['status'],
      outcome: result.outcome as CompleteConnectResult['outcome'],
      accountLogin: result.account_login,
      repositorySelection: result.repository_selection as 'all' | 'selected',
    };
  } catch (err) {
    if (err instanceof ConnectDbError) throw err;
    throw toConnectDbError(err);
  }
}
