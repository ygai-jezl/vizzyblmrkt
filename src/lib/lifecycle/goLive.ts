import { forTenant, type TenantContext } from "@/lib/tenant";
import type { WhereClause } from "@/lib/tenant/repository";
import type { FirestoreLike } from "@/lib/tenant/types";
import { RESERVED_EVENTS } from "@/lib/connect/protocol";
import type { LifecycleJourney, LifecycleVersion } from "@/lib/types/lifecycle";
import { enrolmentDocId, enrolUser, versionDocId } from "./enrol";
import { lifecycleModeCeiling } from "./flags";
import { lowestMode } from "./policy";

/**
 * Going live (LIFECYCLE_GO_LIVE_SWEEP): when a product sign-up journey can first
 * email everyone — its own mode or the environment's ceiling rose to live — enrol
 * the people whose `signedUpAt` is still inside its window, so the product never
 * has to resend them. The tick notices the change, which covers a journey going
 * live and a ceiling lifting alike.
 *
 * It reads the connection's users by `lastSeenAt` (the existing index): anyone who
 * signed up inside the window was seen inside it. Pages resume from a cursor on the
 * journey, and enrolment is idempotent, so re-reading the edge of a page is safe.
 * Dropping below live clears the marker, so the next go-live sweeps again.
 */

/** Users per page. A batch write gives at most 100 users the same `lastSeenAt`, so a page always gets past a tie. */
const PAGE = 500;

export interface GoLiveSweepResult {
  /** Journeys that swept this tick. */
  journeys: number;
  enrolled: number;
}

export async function sweepGoLive(
  ctx: TenantContext,
  deps: { db?: FirestoreLike; now: () => number; deadlineMs: number; pageSize?: number },
): Promise<GoLiveSweepResult> {
  const repo = forTenant(ctx, deps.db);
  const out: GoLiveSweepResult = { journeys: 0, enrolled: 0 };
  const journeys = await repo.lifecycleJourneys.find({ where: [["status", "==", "active"]], limit: 100 });
  for (const journey of journeys) {
    if (journey.audience?.kind === "waitlist" || !journey.connectionId || !journey.publishedVersion) continue;
    if (lowestMode(journey.deliveryMode, lifecycleModeCeiling()) !== "live") {
      if (journey.goLiveSweep) await repo.lifecycleJourneys.update(journey.id, { goLiveSweep: null });
      continue;
    }
    if (journey.goLiveSweep?.status === "done") continue;
    if (deps.now() >= deps.deadlineMs) break;
    const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
    if (!version) continue;
    if (version.settings.trigger.event !== RESERVED_EVENTS.signedUp) {
      // Nothing to sweep (milestone and opt-in times aren't indexed per user); don't look again until it drops below live.
      await repo.lifecycleJourneys.update(journey.id, { goLiveSweep: done(journey, 0, deps.now()) });
      continue;
    }
    out.journeys += 1;
    out.enrolled += await sweepJourney(ctx, journey, version, deps);
  }
  return out;
}

function done(journey: LifecycleJourney, enrolled: number, nowMs: number): NonNullable<LifecycleJourney["goLiveSweep"]> {
  return { status: "done", cursor: null, enrolled: (journey.goLiveSweep?.enrolled ?? 0) + enrolled, updatedAt: new Date(nowMs).toISOString() };
}

async function sweepJourney(
  ctx: TenantContext,
  journey: LifecycleJourney,
  version: LifecycleVersion,
  deps: { db?: FirestoreLike; now: () => number; deadlineMs: number; pageSize?: number },
): Promise<number> {
  const repo = forTenant(ctx, deps.db);
  const pageSize = deps.pageSize ?? PAGE;
  const windowMs = version.settings.trigger.maxEventAgeHours * 3600_000;
  const windowStart = new Date(deps.now() - windowMs).toISOString();
  let cursor = journey.goLiveSweep?.cursor ?? null;
  let enrolled = journey.goLiveSweep?.enrolled ?? 0;
  let added = 0;
  while (deps.now() < deps.deadlineMs) {
    const where: WhereClause[] = [
      ["connectionId", "==", journey.connectionId],
      ["lastSeenAt", ">=", windowStart],
      ...(cursor ? [["lastSeenAt", "<=", cursor] as WhereClause] : []),
    ];
    const page = await repo.productUsers.find({ where, orderBy: [["lastSeenAt", "desc"]], limit: pageSize });
    for (const user of page) {
      const nowMs = deps.now();
      if (user.status !== "active" || !user.signedUpAt || nowMs - Date.parse(user.signedUpAt) > windowMs) continue;
      // Already in: one read, no write.
      if (await repo.lifecycleEnrolments.getById(enrolmentDocId(journey.id, user.id))) continue;
      const r = await enrolUser(ctx, { journey, version, user, source: "trigger", anchorAt: user.signedUpAt }, { db: deps.db, nowMs });
      if (r.outcome === "enrolled") {
        enrolled += 1;
        added += 1;
      }
    }
    const finished = page.length < pageSize;
    const last = page.at(-1)?.lastSeenAt ?? null;
    // Inclusive cursor: the page's last lastSeenAt is read again next time. Never stall on one value.
    cursor = finished || !last ? null : last === cursor ? new Date(Date.parse(last) - 1).toISOString() : last;
    const updatedAt = new Date(deps.now()).toISOString();
    await repo.lifecycleJourneys.update(journey.id, {
      goLiveSweep: { status: finished ? "done" : "running", cursor, enrolled, updatedAt },
    });
    if (finished) break;
  }
  if (added > 0) console.log(`[lifecycle] go-live sweep ${ctx.tenantId}/${journey.id}: enrolled ${added}`);
  return added;
}
