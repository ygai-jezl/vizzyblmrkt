import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import { forTenant } from "@/lib/tenant";
import { journeyIdFor } from "@/lib/journey/service";
import { CONTROL } from "@/lib/journey/allocation";
import { computeSequenceEmailBreakdown } from "@/lib/analytics/email";

/**
 * Promote the winning arm of an email node's A/B test. Copies the winner's copy
 * into the node's BASE subject/body (the control), ends the test
 * (status="promoted", enabled=false), and records the winner. After this,
 * allocateVariant returns control for everyone — and control now IS the winner —
 * so all FUTURE sends use it. Already-sent recipients keep what they got (you
 * can't unsend); that is the meaning of "drop the loser".
 *
 * Human-only operation (the admin Analytics drill-in). Persisted through
 * upsertJourneyDraft so it shares the single validated save path.
 */
export type PromoteResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "journey_not_found"
        | "node_not_found"
        | "no_ab_test"
        | "variant_not_found"
        | "insufficient_data";
    };

export async function promoteVariant(
  ctx: TenantContext,
  campaignId: string,
  nodeId: string,
  winnerVariantId: string,
  opts: { requireMinSample?: number } = {},
  db?: FirestoreLike,
): Promise<PromoteResult> {
  const journey = await forTenant(ctx, db).journeys.getById(journeyIdFor(campaignId));
  if (!journey) return { ok: false, error: "journey_not_found" };

  const node = journey.graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "email") return { ok: false, error: "node_not_found" };

  const ab = node.data.abTest;
  if (!ab || !ab.enabled) return { ok: false, error: "no_ab_test" };

  // Resolve the winning content. "control" keeps the base copy; a variant id must
  // exist in the test.
  let winnerContent: { subject: string; body: string; heroImageUrl: string | null } | null =
    null;
  if (winnerVariantId === CONTROL) {
    winnerContent = {
      subject: node.data.subject ?? "",
      body: node.data.body ?? "",
      heroImageUrl: node.data.heroImageUrl ?? null,
    };
  } else {
    const v = ab.variants.find((x) => x.variantId === winnerVariantId);
    if (!v) return { ok: false, error: "variant_not_found" };
    winnerContent = { subject: v.subject, body: v.body, heroImageUrl: v.heroImageUrl ?? null };
  }

  // Optional guard against promoting on a tiny sample.
  if (opts.requireMinSample && opts.requireMinSample > 0) {
    const { nodes } = await computeSequenceEmailBreakdown(ctx, journey.id, db);
    const stat = nodes.find((n) => n.nodeId === nodeId);
    const arm = stat?.arms.find((a) => a.variantId === winnerVariantId);
    const sent = arm?.sent ?? 0;
    if (sent < opts.requireMinSample) return { ok: false, error: "insufficient_data" };
  }

  // Write the winner into the base copy + close the test, in a fresh graph copy.
  const nextGraph = {
    ...journey.graph,
    nodes: journey.graph.nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            data: {
              ...n.data,
              subject: winnerContent!.subject,
              body: winnerContent!.body,
              heroImageUrl: winnerContent!.heroImageUrl,
              abTest: {
                ...ab,
                enabled: false,
                status: "promoted" as const,
                winnerVariantId,
              },
            },
          }
        : n,
    ),
  };

  // Write the graph directly (not via upsertJourneyDraft, which refuses nothing
  // here but isn't db-injectable): promotion must work on an ACTIVE journey, and
  // an update() touches only graph+updatedAt, so the live status is preserved.
  await forTenant(ctx, db).journeys.update(journeyIdFor(campaignId), {
    graph: nextGraph,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}
