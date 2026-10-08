import { forTenant, type TenantContext } from "@/lib/tenant";
import type { WhereClause } from "@/lib/tenant/repository";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConnectionCatalog, ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { dateStartOf, type DateStart, type JourneyAbout, type LifecycleJourney, type LifecycleVersion } from "@/lib/types/lifecycle";
import { daysSince, parseFactDate } from "@/lib/connect/dateFacts";
import { aboutOf, enrolmentIdFor, enrolUser, utcDayKey, versionDocId, type EnrolOutcome } from "./enrol";
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

/** The date someone would enter on today: set when it's past the line and still inside the window. */
export function dateEntry(dateMs: number | null, start: Pick<DateStart, "days" | "windowDays">, nowMs: number): { dateAt: string; days: number } | null {
  if (dateMs === null) return null;
  const days = daysSince(dateMs, nowMs);
  if (days < start.days || days > start.days + start.windowDays) return null;
  return { dateAt: new Date(dateMs).toISOString(), days };
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

/** Enrol one person (once per entity for a journey about each) if their date is past the line. */
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
    const entry = dateEntry(storedDateMs(user, entityId, about, connection.catalog, start.fact), start, deps.nowMs);
    if (!entry) continue;
    try {
      // Already in: one read, no write (they stay inside the window for days).
      if (await repo.lifecycleEnrolments.getById(enrolmentIdFor(journey.id, user.id, about, entityId))) continue;
      const r = await enrolUser(
        ctx,
        { journey, version, user, source: "trigger", anchorAt: new Date(deps.nowMs).toISOString(), consentPolicy: connection.consentPolicy, entityId, dateAt: entry.dateAt },
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
 * their date is (that's the point of doing it by hand). The date they have now
 * is kept, so the journey still stops when it moves on.
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
