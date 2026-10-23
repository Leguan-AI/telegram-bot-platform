import { NextRequest, NextResponse } from 'next/server';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  interpretWebhook,
  isValidGitHubSignature,
} from '@/lib/githubWebhook';
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
  deleteInstallation,
  refreshRepositorySelection,
  removeRepositoryLinks,
  resolveInstallation,
  setInstallationSuspended,
} from '@/lib/githubEvents';

// A signature check, a dedupe insert and at most two small writes.
export const maxDuration = 20;

/**
 * GitHub App webhook (#21 §4).
 *
 * Its own route, separate from the Telegram webhook: a different sender, a different
 * secret and a different signature scheme, and nothing about one should be able to reach
 * the other.
 *
 * Order matters here, and each step is a gate for the next:
 *   1. HMAC over the **raw** body, before any parse. An unsigned or wrongly signed
 *      delivery is rejected without being read as JSON.
 *   2. Delivery-id dedupe, so a hand-redelivered event cannot be applied twice.
 *   3. Resolve the installation. Unknown means the App is installed somewhere that never
 *      finished connecting here — a 200 and nothing else, not an error.
 *   4. Apply, inside the entity's own RLS context.
 *
 * Everything from step 2 on answers 200: GitHub's delivery log should show success for
 * anything we have genuinely received and decided about, and retrying would not help.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('GitHub webhook received while GITHUB_APP_WEBHOOK_SECRET is unset.');
    return new NextResponse(null, { status: 500 });
  }

  // The raw body, not a re-serialised parse: the signature covers GitHub's exact bytes.
  const rawBody = await req.text();
  const signature = req.headers.get(GITHUB_SIGNATURE_HEADER);

  if (!isValidGitHubSignature(secret, rawBody, signature)) {
    console.warn('GitHub webhook rejected: bad or missing signature.');
    return new NextResponse(null, { status: 401 });
  }

  const event = req.headers.get(GITHUB_EVENT_HEADER) || '';
  const deliveryId = req.headers.get(GITHUB_DELIVERY_HEADER) || '';

  if (!deliveryId) {
    console.warn('GitHub webhook rejected: no delivery id.');
    return NextResponse.json({ ok: false, reason: 'missing_delivery_id' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn(`GitHub webhook ${deliveryId}: body is not JSON.`);
    return NextResponse.json({ ok: false, reason: 'invalid_json' }, { status: 400 });
  }

  try {
    if (!(await claimWebhookDelivery(deliveryId, event))) {
      console.info(`GitHub webhook ${deliveryId}: duplicate delivery ignored.`);
      return NextResponse.json({ ok: true, reason: 'duplicate' });
    }

    const { installationId, action, repositorySelection } = interpretWebhook(event, payload);

    if (installationId === null) {
      return NextResponse.json({ ok: true, reason: 'no_installation' });
    }

    const installation = await resolveInstallation(installationId);
    if (!installation) {
      // Nothing was applied, so give the id back. The App can be installed somewhere that
      // has not finished connecting here, and an operator who redelivers that event after
      // connecting should see it applied rather than dismissed as a duplicate.
      console.info(`GitHub webhook ${deliveryId}: installation ${installationId} is not connected here.`);
      await releaseWebhookDelivery(deliveryId);
      return NextResponse.json({ ok: true, reason: 'unknown_installation' });
    }

    // Applied for every event that carries it, including ones we otherwise ignore — it is
    // how the "All repositories" warning stays true after an owner changes their mind.
    //
    // Note the limit: a selection change on its own tells us the shape of the grant, not
    // which repositories left it. Narrowing from "all" to a subset is expected to arrive
    // as an installation_repositories.removed naming them, which is what unlinks; if
    // GitHub ever sends the selection change without it, links to no-longer-shared
    // repositories would linger until the next removed event. They are inert if it
    // happens — an answer-time token is downscoped per repository id and GitHub refuses
    // anything outside the installation, and the picker's save re-checks against the live
    // list — but reconciling against /installation/repositories on a selection change
    // would close it properly. Worth doing if a delivery log ever shows the gap.
    if (repositorySelection && action.kind !== 'delete_installation') {
      if (await refreshRepositorySelection(installation, repositorySelection)) {
        console.info(
          `GitHub webhook ${deliveryId}: repository_selection now ${repositorySelection} on entity ${installation.entityId}.`
        );
      }
    }

    switch (action.kind) {
      case 'delete_installation': {
        const removed = await deleteInstallation(installation);
        console.info(
          `GitHub webhook ${deliveryId}: installation removed on entity ${installation.entityId} (${removed} row).`
        );
        return NextResponse.json({ ok: true, reason: 'installation_deleted' });
      }

      case 'set_suspended': {
        const changed = await setInstallationSuspended(installation, action.suspended);
        console.info(
          `GitHub webhook ${deliveryId}: installation ${action.suspended ? 'suspended' : 'unsuspended'} on ` +
            `entity ${installation.entityId} (${changed} row; a pending connection stays pending).`
        );
        return NextResponse.json({ ok: true, reason: action.suspended ? 'suspended' : 'unsuspended' });
      }

      case 'remove_repositories': {
        const unlinked = await removeRepositoryLinks(installation, action.repoIds);
        console.info(
          `GitHub webhook ${deliveryId}: ${action.repoIds.length} repository(ies) un-shared on entity ` +
            `${installation.entityId}; ${unlinked} link(s) removed.`
        );
        return NextResponse.json({ ok: true, reason: 'repositories_removed' });
      }

      default:
        return NextResponse.json({ ok: true, reason: action.reason });
    }
  } catch (err) {
    console.error(`GitHub webhook ${deliveryId} failed after the signature check:`, err);
    // Hand the delivery id back, or a redelivery from the App's settings would be
    // dismissed as a duplicate and the event would be lost for good.
    try {
      await releaseWebhookDelivery(deliveryId);
    } catch (releaseErr) {
      console.error(`GitHub webhook ${deliveryId}: could not release the delivery id:`, releaseErr);
    }
    return new NextResponse(null, { status: 500 });
  }
}
