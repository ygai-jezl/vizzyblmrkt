import { forTenant, TenantIsolationError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import type { LifecycleJourney, LifecycleVersion, WaitlistEnrolment, WaitlistHeldReason } from "@/lib/types/lifecycle";
import { entryCursor } from "../planner";
import { isTestRecipient } from "../policy";
import { COUNTER_TTL_MS, counterDocId, utcDayKey, versionDocId } from "../enrol";
import { rehearsalEnrolmentId, waitlistEnrolmentId, waitlistJourneyId } from "./ids";
import { WAITLIST_DUE_LIMIT } from "./runner";

/**
 * Who enters a launch's waitlist journey on the lifecycle engine, and when
 * they're released after a pause (engine move D2).
 *
 * ONE ENGINE PER PERSON: before a real enrolment the signup is stamped
 * `journeyEngine: "lifecycle"` in a transaction, and anyone the original engine
 * already emails (stamped "legacy", or with its journey steps queued from
 * before stamps existed) is skipped. The original engine skips anyone stamped
 * "lifecycle" (activateJourney, the router) and ends their queued steps. A shadow
 * rehearsal never stamps anyone: it only ever mails the operator's inbox.
 */

const DAY_MS = 86_400_000;
const TICK_MS = 2 * 60_000;
/** People held longer than this leave on resume rather than get months-old emails (owner decision, 24 Sept 2026). */
export const WAITLIST_HOLD_MAX_AGE_DAYS = 90;
const PAGE = 300;

export type WaitlistEnrolOutcome =
  | { outcome: "enrolled"; enrolmentId: string; held: boolean }
  | { outcome: "duplicate"; enrolmentId: string }
  | { outcome: "skipped"; reason: string };

/** The launch's waitlist journey on the lifecycle engine, with its published version (null if never published). */
export async function waitlistJourneyFor(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<{ journey: LifecycleJourney; version: LifecycleVersion | null } | null> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(waitlistJourneyId(campaignId));
  if (!journey || journey.audience?.kind !== "waitlist" || journey.audience.campaignId !== campaignId) return null;
  const version = journey.publishedVersion
    ? await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion))
    : null;
  return { journey, version };
}

/**
 * Whether the original engine has this person: their journey steps (queued,
 * held or done) for the launch's original journey. Covers people enrolled
 * before signups were stamped.
 */
async function hasOriginalEngineSteps(ctx: TenantContext, signup: Pick<Signup, "id" | "campaignId">, db?: FirestoreLike): Promise<boolean> {
  const repo = forTenant(ctx, db);
  const legacyId = `journey_${signup.campaignId}`; // the original engine's one journey per launch (journeyIdFor)
  const legacy = await repo.journeys.getById(legacyId);
  if (!legacy) return false;
  const steps = legacy.graph.nodes.filter((n) => n.type === "email" || n.type === "condition" || n.type === "exit");
  const jobs = await Promise.all(steps.map((n) => repo.emailJobs.getById(`journey:${legacyId}:${n.id}:${signup.id}`)));
  return jobs.some(Boolean);
}

/**
 * Stamp the person for the lifecycle engine, once, in a transaction. Returns the
 * engine they're on afterwards ("missing" when the signup is gone).
 */
export async function claimLifecycleEngine(
  ctx: TenantContext,
  signup: Pick<Signup, "id" | "campaignId" | "journeyEngine">,
  db?: FirestoreLike,
): Promise<"lifecycle" | "legacy" | "missing"> {
  if (signup.journeyEngine) return signup.journeyEngine;
  const repo = forTenant(ctx, db);
  if (await hasOriginalEngineSteps(ctx, signup, db)) {
    await repo.signups
      .claim(signup.id, (cur) => (cur.journeyEngine ? null : { journeyEngine: "legacy" as const }))
      .catch(() => null);
    return "legacy";
  }
  const saw: { engine: Signup["journeyEngine"] | "missing" } = { engine: "missing" };
  const stamped = await repo.signups.claim(signup.id, (cur) => {
    saw.engine = cur.journeyEngine ?? null;
    return cur.journeyEngine ? null : { journeyEngine: "lifecycle" as const };
  });
  if (stamped) return "lifecycle";
  return saw.engine ?? "missing";
}

/**
 * Enrol one verified signup in its launch's waitlist journey. A paused journey
 * (or archived launch) still enrols: the person is parked and starts when the
 * journey is turned back on. Enrolment is never capped. Idempotent: a person
 * enters a journey once.
 */
export async function enrolWaitlistSignup(
  ctx: TenantContext,
  a: {
    journey: LifecycleJourney;
    version: LifecycleVersion;
    campaign: Pick<Campaign, "id" | "archivedAt">;
    signup: Signup;
    source: "trigger" | "manual" | "backfill";
    /** A shadow rehearsal: stamps nobody, mails only the shadow inbox. */
    rehearsal?: boolean;
  },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<WaitlistEnrolOutcome> {
  const { journey, version, campaign, signup } = a;
  const skipped = (reason: string): WaitlistEnrolOutcome => ({ outcome: "skipped", reason });
  if (journey.audience?.kind !== "waitlist" || journey.audience.campaignId !== campaign.id || signup.campaignId !== campaign.id) {
    return skipped("wrong_launch");
  }
  if (journey.status !== "active" && journey.status !== "paused") return skipped("journey_not_live");
  if (version.journeyId !== journey.id) return skipped("wrong_version");
  if (signup.status !== "verified_active" || !signup.email) return skipped("not_verified");
  const mode = a.rehearsal ? "shadow" : journey.deliveryMode;
  if (mode === "test" && !isTestRecipient(journey, { externalUserId: signup.id, email: signup.email })) {
    return skipped("not_a_test_recipient");
  }
  const cursor = entryCursor(version.graph);
  if (!cursor) return skipped("journey_empty");

  const repo = forTenant(ctx, deps.db);
  const id = a.rehearsal ? rehearsalEnrolmentId(journey.id, signup.id) : waitlistEnrolmentId(journey.id, signup.id);
  if (!a.rehearsal) {
    if (await repo.waitlistEnrolments.getById(id)) return { outcome: "duplicate", enrolmentId: id };
    const engine = await claimLifecycleEngine(ctx, signup, deps.db);
    if (engine === "missing") return skipped("signup_missing");
    if (engine !== "lifecycle") return skipped("on_original_engine");
  }

  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const heldReason: WaitlistHeldReason | null = campaign.archivedAt
    ? "launch_archived"
    : journey.status !== "active"
      ? "journey_paused"
      : null;
  try {
    await repo.waitlistEnrolments.create(id, {
      journeyId: journey.id,
      versionId: version.id,
      campaignId: campaign.id,
      signupId: signup.id,
      mode,
      status: "active",
      stopReason: null,
      source: a.source,
      requireApproval: false,
      anchorAt: now,
      lastSentAt: null,
      cursor: { nodeId: cursor },
      nextRunAt: heldReason ? null : now,
      heldReason,
      heldAt: heldReason ? now : null,
      windowExemptUntil: null,
      leaseId: null,
      leaseUntil: null,
      pendingSend: null,
      sentItems: [],
      usedInsightIds: [],
      failures: 0,
      log: [{ at: now, event: "enrolled", detail: `${a.source} · ${mode}${heldReason ? ` · waiting (${heldReason.replace(/_/g, " ")})` : ""}` }],
      ...(a.rehearsal ? { rehearsal: true } : {}),
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) return { outcome: "duplicate", enrolmentId: id };
    throw err;
  }

  await repo.lifecycleCounters
    .upsert(
      counterDocId(journey.id, nowMs),
      () => ({ journeyId: journey.id, day: utcDayKey(nowMs), sends: 0, enrolments: 1, ttlAt: new Date(nowMs + COUNTER_TTL_MS) }),
      (cur) => ({ enrolments: (cur.enrolments ?? 0) + 1 }),
    )
    .catch((err) => {
      console.warn(`[lifecycle] waitlist enrolment counter failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  return { outcome: "enrolled", enrolmentId: id, held: heldReason !== null };
}

export interface WaitlistReleaseSummary {
  /** Back in the queue; each gets their next email. */
  released: number;
  /** Held longer than WAITLIST_HOLD_MAX_AGE_DAYS: left the journey. */
  expired: number;
}

/**
 * Release a waitlist journey's parked people once it's live again and the launch
 * isn't archived: back into the queue, paced at one tick's worth at a time so a
 * big resume can't crowd out the tenant's other journeys. Idempotent.
 */
export async function releaseHeldWaitlistEnrolments(
  ctx: TenantContext,
  journey: Pick<LifecycleJourney, "id" | "status">,
  opts: { now?: number; db?: FirestoreLike } = {},
): Promise<WaitlistReleaseSummary> {
  const summary: WaitlistReleaseSummary = { released: 0, expired: 0 };
  if (journey.status !== "active") return summary;
  const now = opts.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  const repo = forTenant(ctx, opts.db);
  let slot = 0;
  for (const reason of ["journey_paused", "launch_archived"] as const) {
    for (let page = 0; page < 10_000; page += 1) {
      const held: WaitlistEnrolment[] = await repo.waitlistEnrolments.find({
        where: [
          ["journeyId", "==", journey.id],
          ["heldReason", "==", reason],
        ],
        limit: PAGE,
      });
      if (held.length === 0) break;
      held.sort((x, y) => (x.heldAt ?? "").localeCompare(y.heldAt ?? ""));
      for (const e of held) {
        const expired = e.heldAt ? now - Date.parse(e.heldAt) > WAITLIST_HOLD_MAX_AGE_DAYS * DAY_MS : false;
        const ok = await repo.waitlistEnrolments.claim(e.id, (cur) => {
          if (cur.heldReason !== reason || cur.status !== "active") return null;
          if (expired) {
            return {
              status: "exited" as const,
              stopReason: "hold_expired",
              heldReason: null,
              cursor: null,
              nextRunAt: null,
              updatedAt: stamp,
            };
          }
          return {
            heldReason: null,
            heldAt: null,
            nextRunAt: new Date(now + Math.floor(slot / WAITLIST_DUE_LIMIT) * TICK_MS).toISOString(),
            updatedAt: stamp,
          };
        });
        if (!ok) continue;
        if (expired) summary.expired += 1;
        else {
          summary.released += 1;
          slot += 1;
        }
      }
      if (held.length < PAGE) break;
    }
  }
  return summary;
}

/** How many people are waiting in a launch's paused waitlist journey (equality-only count). */
export async function countHeldWaitlistEnrolments(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Promise<number> {
  const repo = forTenant(ctx, db);
  const [paused, archived] = await Promise.all([
    repo.waitlistEnrolments.count([
      ["journeyId", "==", journeyId],
      ["heldReason", "==", "journey_paused"],
    ]),
    repo.waitlistEnrolments.count([
      ["journeyId", "==", journeyId],
      ["heldReason", "==", "launch_archived"],
    ]),
  ]);
  return paused + archived;
}

/**
 * Enrol a launch's existing verified signups (a launch that never ran on the
 * original engine, on its first publish). Resumable: stops at the deadline and
 * leaves a cursor on the journey; the next call carries on. Returns whether it
 * finished.
 */
export async function backfillWaitlistJourney(
  ctx: TenantContext,
  a: { journey: LifecycleJourney; version: LifecycleVersion; campaign: Campaign },
  deps: { db?: FirestoreLike; now?: () => number; deadlineAt?: number } = {},
): Promise<{ enrolled: number; done: boolean }> {
  const clock = deps.now ?? Date.now;
  const deadline = deps.deadlineAt ?? clock() + 20_000;
  const repo = forTenant(ctx, deps.db);
  const fresh = await repo.lifecycleJourneys.getById(a.journey.id);
  if (!fresh || fresh.backfill?.status === "done") return { enrolled: 0, done: true };
  const cursor = fresh.backfill?.cursor ?? null;
  // Equality-only (no composite index); processed in id order so a cursor resumes it.
  const people = (
    await repo.signups.find({
      where: [
        ["campaignId", "==", a.campaign.id],
        ["status", "==", "verified_active"],
      ],
    })
  )
    .filter((s) => cursor === null || s.id > cursor)
    .sort((x, y) => x.id.localeCompare(y.id));

  let enrolled = 0;
  let last = cursor;
  let done = true;
  for (const signup of people) {
    if (clock() >= deadline) {
      done = false;
      break;
    }
    const r = await enrolWaitlistSignup(
      ctx,
      { journey: fresh, version: a.version, campaign: a.campaign, signup, source: "backfill" },
      { db: deps.db, nowMs: clock() },
    );
    if (r.outcome === "enrolled") enrolled += 1;
    last = signup.id;
  }
  await repo.lifecycleJourneys.update(a.journey.id, {
    backfill: {
      status: done ? "done" : "running",
      cursor: last,
      enrolled: (fresh.backfill?.enrolled ?? 0) + enrolled,
      updatedAt: new Date(clock()).toISOString(),
    },
  });
  return { enrolled, done };
}
