import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { LifecycleDraft, LifecycleJourney } from "@/lib/types/lifecycle";
import {
  createWaitlistJourney,
  publishLifecycleJourney,
  saveLifecycleDraft,
  setLifecycleJourneyStatus,
  updateLifecycleDelivery,
  type ServiceResult,
} from "../service";
import { convertLegacyJourney, type ConversionReport } from "./convert";
import { waitlistJourneyId } from "./ids";
import { previewEngineMove, type EngineMovePreview } from "./preview";
import { isWaitlistEngineEnabled, isWaitlistEnginePilot } from "./flags";

/**
 * SWITCHING a launch between journey engines (engine move D5), one launch at a
 * time, with a way back:
 *
 *   rehearse       the converted journey runs in SHADOW on the lifecycle engine
 *                  for new signups: only the operator's inbox gets its mail and
 *                  nobody is stamped; the original engine still emails everyone.
 *   switch         the converted journey goes live on the lifecycle engine with
 *                  NO backfill, then the launch flips — new signups get only the
 *                  new engine. People part-way through finish on the original
 *                  journey, which retires itself once nobody is left
 *                  (reconcileWaitlistDrains).
 *   rollback       new signups go back to the original engine; people already on
 *                  the new one finish there.
 *
 * The emergency brake is WAITLIST_ENGINE_ENABLED=false: everyone on the new
 * engine waits, and nobody is dropped. Every switch is recorded on the launch.
 */

export type EngineAction = "rehearse" | "end_rehearsal" | "switch" | "rollback";

export interface EngineStatus {
  engine: "legacy" | "rehearsal" | "lifecycle";
  since: string | null;
  history: NonNullable<Campaign["waitlistEngineHistory"]>;
  enabled: boolean;
  pilot: boolean;
  preview: EngineMovePreview;
  /** Signups who've had emails from BOTH engines' journeys. Must stay 0. */
  doubleSends: number;
  /** The original journey retired itself once everyone had finished on it. */
  originalRetired: boolean;
}

const fail = (status: number, error: string, detail?: unknown): ServiceResult<never> => ({ ok: false, status, error, detail });

/**
 * The ZERO-DOUBLE-SEND check: how many of a launch's signups have a send from
 * both its original journey and its journey on the lifecycle engine. Counts only.
 */
export async function countDoubleSends(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<number> {
  const repo = forTenant(ctx, db);
  const sentBy = async (journeyId: string) =>
    new Set(
      (
        await repo.emailEvents.find({
          where: [
            ["journeyId", "==", journeyId],
            ["type", "==", "send"],
          ],
          limit: 50_000,
        })
      ).map((e) => e.signupId),
    );
  const [original, moved] = await Promise.all([sentBy(`journey_${campaignId}`), sentBy(waitlistJourneyId(campaignId))]);
  let both = 0;
  for (const id of moved) if (original.has(id)) both += 1;
  return both;
}

export async function engineStatus(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<EngineStatus | null> {
  const repo = forTenant(ctx, db);
  const [campaign, preview, doubleSends, original] = await Promise.all([
    repo.campaigns.getById(campaignId),
    previewEngineMove(ctx, campaignId, db),
    countDoubleSends(ctx, campaignId, db).catch(() => 0),
    repo.journeys.getById(`journey_${campaignId}`),
  ]);
  if (!campaign || !preview) return null;
  return {
    engine: campaign.waitlistEngine ?? "legacy",
    since: campaign.waitlistEngineSince ?? null,
    history: campaign.waitlistEngineHistory ?? [],
    enabled: isWaitlistEngineEnabled(),
    pilot: isWaitlistEnginePilot(ctx.tenantId),
    preview,
    doubleSends,
    originalRetired: Boolean(original?.retiredAt),
  };
}

/** Put the converted draft on the launch's lifecycle journey (creating it the first time). */
async function saveConverted(
  ctx: TenantContext,
  campaignId: string,
  draft: LifecycleDraft,
  deps: { db?: FirestoreLike; nowMs: number },
): Promise<ServiceResult<LifecycleJourney>> {
  const id = waitlistJourneyId(campaignId);
  const existing = await forTenant(ctx, deps.db).lifecycleJourneys.getById(id);
  const saved = existing
    ? await saveLifecycleDraft(ctx, id, draft, { db: deps.db, nowMs: deps.nowMs, authoredBy: "human" })
    : await createWaitlistJourney(ctx, { campaignId, draft }, { db: deps.db, nowMs: deps.nowMs });
  return saved.ok ? { ok: true, value: saved.value.journey } : saved;
}

async function recordEngine(
  ctx: TenantContext,
  campaign: Campaign,
  engine: "legacy" | "rehearsal" | "lifecycle",
  deps: { db?: FirestoreLike; nowMs: number },
): Promise<void> {
  const at = new Date(deps.nowMs).toISOString();
  await forTenant(ctx, deps.db).campaigns.update(campaign.id, {
    waitlistEngine: engine,
    waitlistEngineSince: engine === "lifecycle" ? at : (campaign.waitlistEngineSince ?? null),
    waitlistEngineHistory: [...(campaign.waitlistEngineHistory ?? []), { engine, at, by: ctx.email ?? ctx.userId ?? null }].slice(-50),
  });
}

/** Remove a rehearsal's shadow enrolments (never stamped, never real). */
async function purgeRehearsal(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<number> {
  return forTenant(ctx, db).waitlistEnrolments.deleteWhere([
    ["journeyId", "==", waitlistJourneyId(campaignId)],
    ["rehearsal", "==", true],
  ]);
}

export async function switchEngine(
  ctx: TenantContext,
  campaignId: string,
  action: EngineAction,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<ServiceResult<{ engine: EngineStatus["engine"]; report?: ConversionReport; purged?: number }>> {
  const nowMs = deps.nowMs ?? Date.now();
  const d = { db: deps.db, nowMs };
  const repo = forTenant(ctx, deps.db);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) return fail(404, "launch_not_found");
  const engine = campaign.waitlistEngine ?? "legacy";

  if (action === "rollback") {
    // Always possible, even outside the pilot: new signups go back to the original engine.
    if (engine !== "lifecycle") return fail(409, "not_on_lifecycle");
    const original = await repo.journeys.getById(`journey_${campaignId}`);
    if (original?.retiredAt) {
      await repo.journeys.update(original.id, { status: "active", retiredAt: null, updatedAt: new Date(nowMs).toISOString() });
    }
    await recordEngine(ctx, campaign, "legacy", d);
    return { ok: true, value: { engine: "legacy" } };
  }
  if (action === "end_rehearsal") {
    if (engine !== "rehearsal") return fail(409, "not_rehearsing");
    const purged = await purgeRehearsal(ctx, campaignId, deps.db);
    const moved = await repo.lifecycleJourneys.getById(waitlistJourneyId(campaignId));
    if (moved?.status === "active") await setLifecycleJourneyStatus(ctx, moved.id, "paused", d);
    await recordEngine(ctx, campaign, "legacy", d);
    return { ok: true, value: { engine: "legacy", purged } };
  }

  if (!isWaitlistEngineEnabled()) return fail(409, "engine_off");
  if (!isWaitlistEnginePilot(ctx.tenantId)) return fail(403, "not_in_pilot");
  if (engine === "lifecycle") return fail(409, "already_moved");
  if (campaign.archivedAt) return fail(409, "launch_archived");
  const original = await repo.journeys.getById(`journey_${campaignId}`);
  // A journey that has never run (none yet, or a draft) moves as a draft: its first publish enrols everyone.
  const neverRan = !original || original.status === "draft";
  if (original?.status === "paused") return fail(409, "journey_paused");

  const { draft, report } = original
    ? convertLegacyJourney(original, { lenient: neverRan })
    : { draft: null, report: undefined };
  if (original && !draft) return fail(422, "cannot_convert", report?.blocking);

  if (action === "rehearse") {
    if (neverRan) return fail(409, "nothing_to_rehearse");
    if (!ctx.email) return fail(409, "no_shadow_inbox");
    const saved = await saveConverted(ctx, campaignId, draft!, d);
    if (!saved.ok) return saved;
    const delivery = await updateLifecycleDelivery(ctx, saved.value.id, { deliveryMode: "shadow", shadowInbox: ctx.email }, d);
    if (!delivery.ok) return delivery;
    const published = await publishLifecycleJourney(ctx, saved.value.id, d);
    if (!published.ok) return published;
    if (published.value.journey.status === "paused") await setLifecycleJourneyStatus(ctx, saved.value.id, "active", d);
    await recordEngine(ctx, campaign, "rehearsal", d);
    return { ok: true, value: { engine: "rehearsal", report } };
  }

  // switch
  const purged = await purgeRehearsal(ctx, campaignId, deps.db);
  if (neverRan) {
    // Nothing to drain: the launch starts on the new engine with a draft to publish.
    if (draft) {
      const saved = await saveConverted(ctx, campaignId, draft, d);
      if (!saved.ok) return saved;
    } else if (!(await repo.lifecycleJourneys.getById(waitlistJourneyId(campaignId)))) {
      const created = await createWaitlistJourney(ctx, { campaignId }, d);
      if (!created.ok) return created;
    }
    await recordEngine(ctx, campaign, "lifecycle", d);
    return { ok: true, value: { engine: "lifecycle", report, purged } };
  }
  // The original is live: go live on the new engine first (no backfill), then flip the launch.
  const saved = await saveConverted(ctx, campaignId, draft!, d);
  if (!saved.ok) return saved;
  const delivery = await updateLifecycleDelivery(ctx, saved.value.id, { deliveryMode: "live" }, d);
  if (!delivery.ok) return delivery;
  const published = await publishLifecycleJourney(ctx, saved.value.id, { ...d, backfill: false });
  if (!published.ok) return published;
  if (published.value.journey.status !== "active") {
    const resumed = await setLifecycleJourneyStatus(ctx, saved.value.id, "active", d);
    if (!resumed.ok) return resumed;
  }
  await recordEngine(ctx, campaign, "lifecycle", d);
  return { ok: true, value: { engine: "lifecycle", report, purged } };
}

/**
 * Retire each moved launch's original journey once nobody is left part-way
 * through it (run by the tick). Idempotent; counts only.
 */
export async function reconcileWaitlistDrains(ctx: TenantContext, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<{ retired: number }> {
  const repo = forTenant(ctx, deps.db);
  const moved = await repo.campaigns.find({ where: [["waitlistEngine", "==", "lifecycle"]], limit: 200 });
  let retired = 0;
  for (const c of moved) {
    const original = await repo.journeys.getById(`journey_${c.id}`);
    if (!original || original.retiredAt) continue;
    const left = await Promise.all(
      (["pending", "held", "processing"] as const).map((status) =>
        repo.emailJobs.count([
          ["campaignId", "==", c.id],
          ["type", "==", "journey_step"],
          ["status", "==", status],
        ]),
      ),
    );
    if (left.some((n) => n > 0)) continue;
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    await repo.journeys.update(original.id, { status: "paused", retiredAt: at, updatedAt: at });
    retired += 1;
  }
  return { retired };
}

/** People still part-way through a moved launch's original journey (pending, held or sending). */
export async function countFinishingOnOriginal(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<number> {
  const repo = forTenant(ctx, db);
  const counts = await Promise.all(
    (["pending", "held", "processing"] as const).map((status) =>
      repo.emailJobs.count([
        ["campaignId", "==", campaignId],
        ["type", "==", "journey_step"],
        ["status", "==", status],
      ]),
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}
