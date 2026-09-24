import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { versionDocId } from "../enrol";

/**
 * Promote the winning arm of an A/B test in a waitlist journey on the lifecycle
 * engine (engine move D3): from now on everyone who reaches that email gets the
 * winner. Versions are immutable, so the winner is recorded on the journey
 * (`abWinners`) and read live by the runner; people who already had the email
 * keep what they got. Admins only (see the route); the original engine's
 * equivalent is lib/journey/abTest.ts.
 */

export type PromoteWaitlistResult =
  | { ok: true }
  | { ok: false; error: "journey_not_found" | "node_not_found" | "no_ab_test" | "variant_not_found" | "insufficient_data" };

export async function promoteWaitlistVariant(
  ctx: TenantContext,
  journeyId: string,
  nodeId: string,
  winnerItemId: string,
  opts: { requireMinSample?: number; nowMs?: number } = {},
  db?: FirestoreLike,
): Promise<PromoteWaitlistResult> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.audience?.kind !== "waitlist" || !journey.publishedVersion) return { ok: false, error: "journey_not_found" };
  const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
  const node = version?.graph.nodes.find((n) => n.id === nodeId && n.type === "email");
  const pool = node ? version!.pools.find((p) => p.id === node.data.poolId) : undefined;
  if (!node || !pool) return { ok: false, error: "node_not_found" };
  if (!pool.abTest || pool.items.length < 2) return { ok: false, error: "no_ab_test" };
  if (!pool.items.some((i) => i.id === winnerItemId)) return { ok: false, error: "variant_not_found" };

  if (opts.requireMinSample && opts.requireMinSample > 0) {
    // Sends of that arm from either engine (a moved journey keeps its node and arm ids).
    const counts = await Promise.all(
      [journey.id, `journey_${journey.audience.campaignId}`].map((jid) =>
        repo.emailEvents.count([
          ["journeyId", "==", jid],
          ["nodeId", "==", nodeId],
          ["variantId", "==", winnerItemId],
          ["type", "==", "send"],
        ]),
      ),
    );
    if (counts.reduce((a, b) => a + b, 0) < opts.requireMinSample) return { ok: false, error: "insufficient_data" };
  }

  await repo.lifecycleJourneys.update(journey.id, {
    abWinners: { ...(journey.abWinners ?? {}), [pool.id]: winnerItemId },
    updatedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
  });
  return { ok: true };
}
