/**
 * GitHub webhook effects on the database (#21 §4).
 *
 * The only cross-tenant step is resolving the installation, which is what establishes the
 * entity in the first place. Everything after it runs inside withTenantContext, under the
 * ordinary RLS policies, so a bug in the routing cannot write to another tenant.
 */

import { sql, withTenantContext } from '@/lib/supabase';

export interface ResolvedInstallation {
  entityId: string;
  installationRowId: string;
  status: 'pending_confirmation' | 'active' | 'suspended';
  repositorySelection: 'all' | 'selected';
}

/**
 * The entity behind a numeric installation id, or null when no entity has it connected.
 * Null is the "unknown installation" case the route answers 200 to: the App may well be
 * installed somewhere that never finished connecting here, and that is not an error.
 */
export async function resolveInstallation(installationId: number): Promise<ResolvedInstallation | null> {
  const rows = await sql<{ result: Record<string, string> | null }[]>`
    select public.resolve_github_installation(${installationId.toString()}) as result
  `;
  const result = rows[0]?.result;
  if (!result) return null;

  return {
    entityId: result.entity_id,
    installationRowId: result.installation_row_id,
    status: result.status as ResolvedInstallation['status'],
    repositorySelection: result.repository_selection as 'all' | 'selected',
  };
}

/** installation.deleted — the owner removed the App. Links and pins cascade. */
export async function deleteInstallation(installation: ResolvedInstallation): Promise<number> {
  return withTenantContext(installation.entityId, async (tx) => {
    const rows = await tx`
      delete from public.github_installations
      where id = ${installation.installationRowId}
      returning id
    `;
    return rows.length;
  });
}

/**
 * installation.suspend / unsuspend.
 *
 * Deliberately only moves between `active` and `suspended`. A connection still awaiting an
 * admin's confirmation must stay `pending_confirmation` through both: letting unsuspend
 * set it `active` would activate a connection no admin ever confirmed, which is exactly
 * the §2b guarantee.
 */
export async function setInstallationSuspended(
  installation: ResolvedInstallation,
  suspended: boolean
): Promise<number> {
  const from = suspended ? 'active' : 'suspended';
  const to = suspended ? 'suspended' : 'active';

  return withTenantContext(installation.entityId, async (tx) => {
    const rows = await tx`
      update public.github_installations
      set status = ${to}
      where id = ${installation.installationRowId}
        and status = ${from}
      returning id
    `;
    return rows.length;
  });
}

/**
 * installation_repositories.removed — the owner un-shared repositories. Every link to them
 * goes, at whatever scope: entity-level, group-level and topic pins alike.
 */
export async function removeRepositoryLinks(
  installation: ResolvedInstallation,
  repoIds: number[]
): Promise<number> {
  if (repoIds.length === 0) return 0;

  // As a comma-separated string parsed in SQL, rather than relying on the driver's
  // array-element type inference to land on bigint.
  const csv = repoIds.map((id) => id.toString()).join(',');

  return withTenantContext(installation.entityId, async (tx) => {
    const rows = await tx`
      delete from public.repo_links
      where entity_id = ${installation.entityId}
        and repo_id = any (string_to_array(${csv}, ',')::bigint[])
      returning id
    `;
    return rows.length;
  });
}

/** Keeps our copy of the owner's "all / selected" choice honest (#21 §3's warning). */
export async function refreshRepositorySelection(
  installation: ResolvedInstallation,
  selection: 'all' | 'selected'
): Promise<boolean> {
  if (selection === installation.repositorySelection) return false;

  return withTenantContext(installation.entityId, async (tx) => {
    const rows = await tx`
      update public.github_installations
      set repository_selection = ${selection}
      where id = ${installation.installationRowId}
      returning id
    `;
    return rows.length > 0;
  });
}

/**
 * Records a delivery id, returning false if it has been seen before.
 *
 * GitHub does not retry on its own, but a delivery can be redelivered by hand from the
 * App's settings, and applying an event twice is not always harmless.
 */
export async function claimWebhookDelivery(deliveryId: string, event: string): Promise<boolean> {
  const rows = await sql`
    insert into public.github_webhook_deliveries (delivery_id, event)
    values (${deliveryId}, ${event})
    on conflict (delivery_id) do nothing
    returning delivery_id
  `;
  return rows.length > 0;
}

/**
 * Gives a claimed delivery id back after a failure, so a redelivery from the App's
 * settings is treated as new work rather than as a duplicate. Safe because every effect
 * above is idempotent: re-applying a delete, a status change, an unlink or a selection
 * refresh reaches the same state.
 */
export async function releaseWebhookDelivery(deliveryId: string): Promise<void> {
  await sql`delete from public.github_webhook_deliveries where delivery_id = ${deliveryId}`;
}
