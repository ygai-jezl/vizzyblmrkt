import { forTenant, type TenantContext } from "@/lib/tenant";
import type { WhereClause } from "@/lib/tenant/repository";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConnectionCatalog, ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { dateStartOf, type DateStart, type JourneyAbout, type LifecycleEnrolment, type LifecycleJourney, type LifecycleVersion } from "@/lib/types/lifecycle";
import { parseFactDate } from "@/lib/connect/dateFacts";
import { aboutOf, enrolmentIdFor, enrolUser, reentryDateOf, utcDayKey, versionDocId, type EnrolOutcome } from "./enrol";
import { enrolTargets, entityViewFor, viewedUser } from "./entities";

/**
 * Journeys that START WHEN A DATE PASSES (LIFECYCLE_DATE_START).
 *
 * "Starts when" names one of the catalog's date facts and a number of days:
 * "Last active was more than 14 days ago". Nobody sends an event when a person
 * does nothing, so a DAILY CHECK starts these journeys: once a day, after
 * DATE_SWEEP_HOUR_UTC, it reads the product's people and enrols whoever has
 * crossed the line. Only the stored state is read (the values the product
 * pushed): asking the product about every person every day would be heavy, and
 * the runner asks it for the live value before each email anyway.
 *
 * - Past the line means the date is at least `days` whole days ago, and not
 *   more than `windowDays` past that — so the first check after going live
 *   doesn't take everyone who ever went quiet, and a missed day is caught the next.
 * - ENTERING AGAIN. One date is one entry: an enrolment's id carries the date
 *   entered on, so the same quiet spell never enrols twice. When their date has
 *   moved on and passed the line again they can enter again — never while an
 *   earlier entry is still running, and no sooner than `reenterAfterDays` after
 *   they last entered. Someone held back only by that gap enters when it ends:
 *   the window then counts from there. With `reenterAfterDays` null, each
 *   person enters once.
 * - The usual entry rules apply (enrolUser): delivery mode, consent, exclusions
 *   and the journey's daily enrolment cap. At the cap the day's check ends; the
 *   people left over are still inside the window tomorrow.
 * - It pages by `lastSeenAt` (the existing index) and is resumable across ticks:
 *   the journey's `dateSweep` holds the day, the cursor and the day's count.
 */

/** The daily check runs once the UTC clock reaches this hour (after an overnight sync of the product's people). */
export const DATE_SWEEP_HOUR_UTC = 7;
/** Users per page. A batch write gives at most 100 users the same `lastSeenAt`, so a page always gets past a tie. */
const PAGE = 500;

/**
 * The value of a date fact for one enrolment target, as the journey reads it: the
 * person's own, or — for a journey about one (or each) of their entities — that
 * entity's on top. Null when they have no such date.
 */
export function storedDateMs(
  user: Pick<ProductUser, "steps" | "facts" | "entities">,
  entityId: string | null,
  about: JourneyAbout,
  catalog: Pick<ConnectionCatalog, "onboardingSteps" | "facts" | "entityKinds">,
  factId: string,
): number | null {
  const view = entityViewFor(user, about, catalog, { pinned: entityId, triggerId: entityId });
  if (about.mode === "each" && !view.entity) return null;
  return parseFactDate(viewedUser(user, view, catalog).facts?.[factId]?.value);
}

const DAY_MS = 86_400_000;
/** A product's push can trail the truth by a day or so: how much later than "date + gap" an earlier entry may still hold someone back. */
const GAP_SLACK_DAYS = 2;

/**
 * Whether a date is worth a closer look today: past the line, and not so far past
 * it that no rule could still let them in. Reads nothing — it keeps the daily check
 * to one read per person for everyone else.
 */
export function mayEnter(dateMs: number | null, start: Pick<DateStart, "days" | "windowDays" | "reenterAfterDays">, nowMs: number): boolean {
  if (dateMs === null || nowMs < dateMs + start.days * DAY_MS) return false;
  const gap = start.reenterAfterDays;
  const latestDays = gap === null ? start.days : Math.max(start.days, gap + GAP_SLACK_DAYS);
  return nowMs < dateMs + (latestDays + start.windowDays + 1) * DAY_MS;
}

export type EntryDecision = "enter" | "not_yet" | "window_passed" | "in_journey" | "entered_before" | "too_soon";

/**
 * Whether someone enters today, given their date and their earlier entries in this
 * journey (for a journey about each entity: the ones about this entity).
 *
 * Their door opens when the date is `days` days old — or, if they've been in before,
 * when the gap after that entry ends, should that be later — and stays open for the
 * window. `byHand` ignores the line, the window and the gap: only "never two at
 * once" and "each person once" still hold.
 */
export function decideEntry(
  dateMs: number,
  start: Pick<DateStart, "days" | "windowDays" | "reenterAfterDays">,
  earlier: ReadonlyArray<{ status: string; createdAt: string }>,
  nowMs: number,
  opts: { byHand?: boolean } = {},
): EntryDecision {
  if (earlier.some((e) => e.status === "active")) return "in_journey";
  if (earlier.length > 0 && start.reenterAfterDays === null) return "entered_before";
  if (opts.byHand) return "enter";
  const lineMs = dateMs + start.days * DAY_MS;
  if (nowMs < lineMs) return "not_yet";
  const lastMs = earlier.reduce((m, e) => Math.max(m, Date.parse(e.createdAt) || 0), 0);
  const opensMs = Math.max(lineMs, lastMs && start.reenterAfterDays !== null ? lastMs + start.reenterAfterDays * DAY_MS : 0);
  if (nowMs < opensMs) return "too_soon";
  return nowMs < opensMs + (start.windowDays + 1) * DAY_MS ? "enter" : "window_passed";
}

/** Someone's earlier entries in a journey — for a journey about each of their entities, the ones about this entity. */
async function earlierEntries(
  ctx: TenantContext,
  a: { journeyId: string; productUserId: string; about: JourneyAbout; entityId: string | null },
  db?: FirestoreLike,
): Promise<LifecycleEnrolment[]> {
  const rows = await forTenant(ctx, db).lifecycleEnrolments.find({
    where: [
      ["journeyId", "==", a.journeyId],
      ["productUserId", "==", a.productUserId],
    ],
    limit: 100,
  });
  return a.about.mode === "each" ? rows.filter((e) => (e.entityId ?? null) === a.entityId) : rows;
}

export interface DateSweepResult {
  /** Journeys that checked people this run. */
  journeys: number;
  checked: number;
  enrolled: number;
}

interface SweepDeps {
  db?: FirestoreLike;
  now: () => number;
  deadlineMs: number;
  pageSize?: number;
}

/** The tick's part: every active date-started journey of the tenant whose check for today isn't done. */
export async function sweepDateStarts(ctx: TenantContext, deps: SweepDeps): Promise<DateSweepResult> {
  const out: DateSweepResult = { journeys: 0, checked: 0, enrolled: 0 };
  if (new Date(deps.now()).getUTCHours() < DATE_SWEEP_HOUR_UTC) return out;
  const repo = forTenant(ctx, deps.db);
  const journeys = await repo.lifecycleJourneys.find({ where: [["status", "==", "active"]], limit: 100 });
  for (const journey of journeys) {
    if (!journey.startsOnDate || journey.audience?.kind === "waitlist" || !journey.connectionId || !journey.publishedVersion) continue;
    const day = utcDayKey(deps.now());
    if (journey.dateSweep?.day === day && journey.dateSweep.status === "done") continue;
    if (deps.now() >= deps.deadlineMs) break;
    const r = await sweepJourney(ctx, journey, deps);
    if (!r) continue;
    out.journeys += 1;
    out.checked += r.checked;
    out.enrolled += r.enrolled;
  }
  return out;
}

/**
 * "Check now" on a journey: today's check from the start, whatever the hour and
 * whether or not it already ran. Safe to repeat — nobody enters twice for one date.
 */
export async function checkDatesNow(
  ctx: TenantContext,
  journey: LifecycleJourney,
  deps: SweepDeps,
): Promise<{ checked: number; enrolled: number; finished: boolean } | null> {
  return sweepJourney(ctx, { ...journey, dateSweep: null }, deps);
}

/** One journey's check for today, from where it left off. Null when it has nothing to check (not a date start, or its product is gone or paused). */
async function sweepJourney(
  ctx: TenantContext,
  journey: LifecycleJourney,
  deps: SweepDeps,
): Promise<{ checked: number; enrolled: number; finished: boolean } | null> {
  const repo = forTenant(ctx, deps.db);
  if (!journey.publishedVersion) return null;
  const [version, connection] = await Promise.all([
    repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion)),
    repo.productConnections.getById(journey.connectionId),
  ]);
  const start = version ? dateStartOf(version.settings) : null;
  if (!version || !start || !connection || connection.status !== "active") return null;

  const day = utcDayKey(deps.now());
  const resumed = journey.dateSweep?.day === day && journey.dateSweep.status === "running" ? journey.dateSweep : null;
  const pageSize = deps.pageSize ?? PAGE;
  let cursor = resumed?.cursor ?? null;
  let enrolled = resumed?.enrolled ?? 0;
  let checked = resumed?.checked ?? 0;
  const before = { enrolled, checked };
  let finished = false;
  /** The people at the cursor's `lastSeenAt` this run has already read (the cursor is inclusive). */
  let atCursor = new Set<string>();
  while (deps.now() < deps.deadlineMs && !finished) {
    const where: WhereClause[] = [["connectionId", "==", journey.connectionId], ...(cursor ? [["lastSeenAt", "<=", cursor] as WhereClause] : [])];
    const page = await repo.productUsers.find({ where, orderBy: [["lastSeenAt", "desc"]], limit: pageSize });
    let capped = false;
    for (const user of page) {
      if (atCursor.has(user.id)) continue;
      checked += 1;
      const r = await enrolIfPast(ctx, { journey, version, connection, start, user }, { db: deps.db, nowMs: deps.now() });
      enrolled += r.enrolled;
      if (r.capped) {
        capped = true;
        break;
      }
    }
    // At the cap the day's check is over: the people left are still inside the window tomorrow.
    finished = capped || page.length < pageSize;
    const last = page.at(-1)?.lastSeenAt ?? null;
    // Inclusive cursor: the page's last lastSeenAt is read again next time. Never stall on one value.
    cursor = finished || !last ? null : last === cursor ? new Date(Date.parse(last) - 1).toISOString() : last;
    atCursor = new Set(page.filter((u) => u.lastSeenAt === cursor).map((u) => u.id));
    await repo.lifecycleJourneys.update(journey.id, {
      dateSweep: { day, status: finished ? "done" : "running", cursor, enrolled, checked, updatedAt: new Date(deps.now()).toISOString() },
    });
  }
  const added = enrolled - before.enrolled;
  if (added > 0) console.log(`[lifecycle] date check ${ctx.tenantId}/${journey.id}: enrolled ${added}`);
  return { checked: checked - before.checked, enrolled: added, finished };
}

/** Enrol one person (once per entity for a journey about each) if their date is past the line and the rules let them in. */
async function enrolIfPast(
  ctx: TenantContext,
  a: { journey: LifecycleJourney; version: LifecycleVersion; connection: ProductConnection; start: DateStart; user: ProductUser },
  deps: { db?: FirestoreLike; nowMs: number },
): Promise<{ enrolled: number; capped: boolean }> {
  const { journey, version, connection, start, user } = a;
  if (user.status !== "active") return { enrolled: 0, capped: false };
  const repo = forTenant(ctx, deps.db);
  const about = aboutOf(version);
  let enrolled = 0;
  for (const entityId of enrolTargets(user, about)) {
    const dateMs = storedDateMs(user, entityId, about, connection.catalog, start.fact);
    if (dateMs === null || !mayEnter(dateMs, start, deps.nowMs)) continue;
    const dateAt = new Date(dateMs).toISOString();
    try {
      // Already in for this date: one read, no write (they stay inside the window for days).
      if (await repo.lifecycleEnrolments.getById(enrolmentIdFor(journey.id, user.id, about, entityId, reentryDateOf(version, dateAt)))) continue;
      const earlier = await earlierEntries(ctx, { journeyId: journey.id, productUserId: user.id, about, entityId }, deps.db);
      if (decideEntry(dateMs, start, earlier, deps.nowMs) !== "enter") continue;
      const r = await enrolUser(
        ctx,
        { journey, version, user, source: "trigger", anchorAt: new Date(deps.nowMs).toISOString(), consentPolicy: connection.consentPolicy, entityId, dateAt },
        deps,
      );
      if (r.outcome === "enrolled") enrolled += 1;
      else if (r.outcome === "skipped" && r.reason === "enrolment_cap") return { enrolled, capped: true };
    } catch (err) {
      // One person's trouble never ends the day's check for everyone after them.
      console.error(`[lifecycle] date check enrol failed ${ctx.tenantId}/${journey.id}/${user.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  return { enrolled, capped: false };
}

/**
 * Enrol someone by hand in a journey that starts when a date passes — wherever
 * their date is, and whatever the gap since they were last in (that's the point of
 * doing it by hand). The date they have now is kept, so the journey still stops
 * when it moves on. Never while an earlier entry is running, and never a second
 * time in a journey people enter once.
 */
export async function enrolOnDateByHand(
  ctx: TenantContext,
  a: { journey: LifecycleJourney; version: LifecycleVersion; user: ProductUser; catalog: ConnectionCatalog; start: DateStart },
  deps: { db?: FirestoreLike; nowMs: number },
): Promise<EnrolOutcome[]> {
  const about = aboutOf(a.version);
  const out: EnrolOutcome[] = [];
  for (const entityId of enrolTargets(a.user, about)) {
    const ms = storedDateMs(a.user, entityId, about, a.catalog, a.start.fact);
    const earlier = await earlierEntries(ctx, { journeyId: a.journey.id, productUserId: a.user.id, about, entityId }, deps.db);
    if (decideEntry(ms ?? 0, a.start, earlier, deps.nowMs, { byHand: true }) !== "enter") {
      const running = earlier.find((e) => e.status === "active") ?? earlier[0]!;
      out.push({ outcome: "duplicate", enrolmentId: running.id });
      continue;
    }
    out.push(
      await enrolUser(
        ctx,
        { journey: a.journey, version: a.version, user: a.user, source: "manual", anchorAt: new Date(deps.nowMs).toISOString(), entityId, dateAt: ms === null ? null : new Date(ms).toISOString() },
        deps,
      ),
    );
  }
  return out;
}
