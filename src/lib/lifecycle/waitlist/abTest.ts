import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Journey } from "@/lib/types/journey";
import type { ContentPool, LifecycleJourney } from "@/lib/types/lifecycle";
import { CONTROL } from "@/lib/journey/allocation";
import { promoteVariant } from "@/lib/journey/abTest";
import { journeyIdFor } from "@/lib/journey/service";
import { versionDocId } from "../enrol";
import { waitlistJourneyId } from "./ids";
import { liveWinners, pickHolds } from "./winners";

/**
 * Promote the winning arm of an A/B test in a waitlist journey on the lifecycle
 * engine (engine move D3): from now on everyone who reaches that email gets the
 * winner. Versions are immutable, so the winner is recorded on the journey
 * (`abWinners`) and read live by the runner; people who already had the email
 * keep what they got. Admins only (see the route); the original engine's
 * equivalent is lib/journey/abTest.ts.
 */

type PickError = "journey_not_found" | "node_not_found" | "no_ab_test" | "variant_not_found" | "insufficient_data" | "already_promoted";

export type PromoteWaitlistResult = { ok: true } | { ok: false; error: PickError };

type History = NonNullable<LifecycleJourney["abWinnerHistory"]>;

/**
 * Where a pick stands on one journey: ready to write, already this winner, another winner, or not
 * possible there. Ready and done carry the test's arms, so a pick reaches a second journey only
 * where it runs the same test.
 */
type PickState =
  | { state: "ready"; arms: string[] }
  | { state: "done"; arms: string[] }
  | { state: "taken" }
  | { state: "missing"; error: PickError };

/** The launch's waitlist journey on the lifecycle engine and the email's pool in its published version. */
async function lifecyclePick(
  ctx: TenantContext,
  journeyId: string,
  nodeId: string,
  winnerItemId: string,
  db?: FirestoreLike,
): Promise<{ check: PickState; journey?: LifecycleJourney; campaignId?: string; pool?: ContentPool }> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.audience?.kind !== "waitlist" || !journey.publishedVersion) return { check: { state: "missing", error: "journey_not_found" } };
  const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
  const node = version?.graph.nodes.find((n) => n.id === nodeId && n.type === "email");
  const pool = node ? version!.pools.find((p) => p.id === node.data.poolId) : undefined;
  if (!node || !pool) return { check: { state: "missing", error: "node_not_found" } };
  const current = liveWinners(journey, version!.pools)[pool.id];
  const found = { journey, campaignId: journey.audience.campaignId, pool };
  const arms = pool.items.map((i) => i.id);
  if (current) return { check: current === winnerItemId ? { state: "done", arms } : { state: "taken" }, ...found };
  if (!pool.abTest || pool.items.length < 2) return { check: { state: "missing", error: "no_ab_test" } };
  if (!arms.includes(winnerItemId)) return { check: { state: "missing", error: "variant_not_found" } };
  return { check: { state: "ready", arms }, ...found };
}

/** The same check on the launch's original journey (lib/journey/abTest.ts writes it). */
function originalPick(journey: Journey | null, nodeId: string, winnerVariantId: string): PickState {
  if (!journey) return { state: "missing", error: "journey_not_found" };
  const node = journey.graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "email") return { state: "missing", error: "node_not_found" };
  const ab = node.data.abTest;
  // promoteVariant keeps the variants on a decided test, so its arms stay known.
  const arms = ab ? [CONTROL, ...ab.variants.map((v) => v.variantId)] : [];
  if (ab?.status === "promoted") return ab.winnerVariantId === winnerVariantId ? { state: "done", arms } : { state: "taken" };
  if (!ab || !ab.enabled) return { state: "missing", error: "no_ab_test" };
  if (!arms.includes(winnerVariantId)) return { state: "missing", error: "variant_not_found" };
  return { state: "ready", arms };
}

/** Sends of one arm from either engine: a moved journey keeps its node and arm ids. */
async function armSends(ctx: TenantContext, journeyIds: string[], nodeId: string, variantId: string, db?: FirestoreLike): Promise<number> {
  const counts = await Promise.all(
    journeyIds.map((jid) =>
      forTenant(ctx, db).emailEvents.count([
        ["journeyId", "==", jid],
        ["nodeId", "==", nodeId],
        ["variantId", "==", variantId],
        ["type", "==", "send"],
      ]),
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}

export async function promoteWaitlistVariant(
  ctx: TenantContext,
  journeyId: string,
  nodeId: string,
  winnerItemId: string,
  opts: { requireMinSample?: number; nowMs?: number } = {},
  db?: FirestoreLike,
): Promise<PromoteWaitlistResult> {
  const { check, journey, campaignId, pool } = await lifecyclePick(ctx, journeyId, nodeId, winnerItemId, db);
  if (check.state === "missing") return { ok: false, error: check.error };
  // Picking the same winner again changes nothing; another winner needs its test restarted first.
  if (check.state === "done") return { ok: true };
  if (check.state === "taken") return { ok: false, error: "already_promoted" };

  if (opts.requireMinSample && opts.requireMinSample > 0) {
    const sent = await armSends(ctx, [journey!.id, journeyIdFor(campaignId!)], nodeId, winnerItemId, db);
    if (sent < opts.requireMinSample) return { ok: false, error: "insufficient_data" };
  }

  const at = new Date(opts.nowMs ?? Date.now()).toISOString();
  // Recorded like a published version: when, and by whom (publishedBy's user id, else email).
  const pick: History[number] = { poolId: pool!.id, nodeId, itemId: winnerItemId, arms: pool!.items.map((i) => i.id), at, by: ctx.userId ?? ctx.email ?? null };
  await forTenant(ctx, db).lifecycleJourneys.update(journey!.id, {
    abWinners: { ...(journey!.abWinners ?? {}), [pool!.id]: winnerItemId },
    abWinnerHistory: [...(journey!.abWinnerHistory ?? []), pick].slice(-50),
    updatedAt: at,
  });
  return { ok: true };
}

export type PromoteLaunchResult = { ok: true; applied: Array<"original" | "lifecycle"> } | { ok: false; error: PickError };

/**
 * A person's pick from a launch's Analytics tab (WAITLIST_AB_WINNER_ENABLED), on every journey
 * that sends the launch's emails. The journey new signups get decides: the lifecycle engine's
 * once the launch has moved (or has no original journey), else the original. Its refusal is the
 * answer and nothing is written. The other journey takes the pick too where it runs the same test
 * (pickHolds: each of its versions was in the test picked from), so people finishing there get the
 * winner as well; a different test there, such as the one before a restart, keeps running.
 * Picking the same winner again is a no-op, so a retry after a failed write completes it. Admins
 * only (see the route).
 */
export async function promoteLaunchWinner(
  ctx: TenantContext,
  campaignId: string,
  nodeId: string,
  winnerVariantId: string,
  opts: { requireMinSample?: number; nowMs?: number } = {},
  db?: FirestoreLike,
): Promise<PromoteLaunchResult> {
  const repo = forTenant(ctx, db);
  const movedId = waitlistJourneyId(campaignId);
  const [campaign, originalJourney, lifecycle] = await Promise.all([
    repo.campaigns.getById(campaignId),
    repo.journeys.getById(journeyIdFor(campaignId)),
    lifecyclePick(ctx, movedId, nodeId, winnerVariantId, db),
  ]);
  if (!campaign) return { ok: false, error: "journey_not_found" };
  const original = originalPick(originalJourney, nodeId, winnerVariantId);
  const lifecycleFirst = campaign.waitlistEngine === "lifecycle" || !originalJourney;
  const [first, other] = lifecycleFirst
    ? [{ engine: "lifecycle" as const, check: lifecycle.check }, { engine: "original" as const, check: original }]
    : [{ engine: "original" as const, check: original }, { engine: "lifecycle" as const, check: lifecycle.check }];

  if (first.check.state === "missing") return { ok: false, error: first.check.error };
  if (first.check.state === "taken") return { ok: false, error: "already_promoted" };
  if (first.check.state === "ready" && opts.requireMinSample && opts.requireMinSample > 0) {
    const sent = await armSends(ctx, [journeyIdFor(campaignId), movedId], nodeId, winnerVariantId, db);
    if (sent < opts.requireMinSample) return { ok: false, error: "insufficient_data" };
  }

  const write = async (engine: "original" | "lifecycle") =>
    engine === "original"
      ? promoteVariant(ctx, campaignId, nodeId, winnerVariantId, {}, db)
      : promoteWaitlistVariant(ctx, movedId, nodeId, winnerVariantId, { nowMs: opts.nowMs }, db);

  const applied: Array<"original" | "lifecycle"> = [];
  if (first.check.state === "ready") {
    const r = await write(first.engine);
    if (!r.ok) return r;
    applied.push(first.engine);
  }
  // The other journey only where it runs the same test and has no other winner. Both engines
  // call the first version "control", so a shared winner id alone does not make it the same test.
  const pickedFrom = first.check.state === "ready" || first.check.state === "done" ? first.check.arms : [];
  if (other.check.state === "ready" && pickHolds(pickedFrom, winnerVariantId, other.check.arms) && (await write(other.engine)).ok) {
    applied.push(other.engine);
  }
  return { ok: true, applied };
}
