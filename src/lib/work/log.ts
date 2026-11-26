import { createHash } from "node:crypto";
import { appendWorkLog, appendWorkLogOnce, findWorkTaskByRef, listWorkLog, saveDraftedWorkLog } from "@/lib/tenant";
import { addDaysToKey, wallTimeToUtc } from "@/lib/lifecycle/sendWindow";
import type { Region } from "@/lib/types/tenant";
import { carryOverOn, deriveDay, LOG_LOOKBACK_DAYS, LOG_RAIL_DAYS, railDays, workstreamKey, type InFlight, type LogDay } from "./day";
import type { CarryBody, LogEntryBody } from "./inputs";
import { draftRefusal, ok, refuse, type DraftedSave, type WorkResult } from "./result";
import { dayIn } from "./schedule";
import { planKeyOf } from "./screenWords";
import { brandIn, nowOf, seesTask, type WorkDeps, type WorkScope } from "./scope";
import { dueChecks, entriesToday, loadTasks, type RegionDown, type WorkTaskView } from "./service";
import { isDay, withoutLoopLines, WORK_LIMITS, type WorkLogRow, type WorkLogRowOf, type WorkStatus } from "./types";
import { placeForNew } from "./validate";
import { REGION_CONFIGS } from "@/lib/tenant";

/**
 * The Log (ADR-0020): the day's entries people type, what is still in flight, the tasks that
 * moved, the decisions made and, today, the checks due. Entries are stored; the rest of the day is
 * worked out from the rows when it is read (src/lib/work/day.ts). Days are the session brand's.
 * In the brand view only the brand's own rows show.
 */

/** The most rows one Log read takes in each region. */
const LOG_ROWS = 2000;

export interface LogDayView extends LogDay {
  today: boolean;
  timeZone: string;
  /** The tasks the day's rows name, by id: ref, title and status, for the ones the person sees. */
  tasks: Record<string, { ref: number; title: string; status: WorkStatus; brandId: string | null }>;
  /** The title of each plan the day's decisions approve, by planKeyOf(url, version), from its task's plan link. */
  planTitles: Record<string, string>;
  /** Today only: the checks due now. */
  checks: WorkTaskView[];
  regionsDown: RegionDown[];
  /** A region held more rows in the days read than one read takes there, so the oldest in flight may be missing. */
  capped: boolean;
  /**
   * Today only: how many workstreams Carry over would log now, worked out as the carry works it
   * out (carryable). None on a past day, and none while a region didn't answer, when it refuses.
   */
  carry: number;
}

/** The note on an entry Carry over logs, as the approved canvas draws it. */
export const CARRIED_NOTE = "Carried over from yesterday.";

/** The tool an entry Carry over logs names in its source, so the Log and get_work can say so. */
export const CARRY_TOOL = "work_carry";

/** The rows the Log reads for one day: a year back for what is in flight, to the end of the day. */
function logWindow(shown: string, tz: string): { readFrom: string; from: string; to: string } {
  const readFrom = addDaysToKey(shown, -LOG_LOOKBACK_DAYS);
  return {
    readFrom,
    from: new Date(wallTimeToUtc(readFrom, 0, 0, tz)).toISOString(),
    to: new Date(wallTimeToUtc(addDaysToKey(shown, 1), 0, 0, tz)).toISOString(),
  };
}

/** The rows of a read this person sees: all of them in the organisation view, their brand's in the brand view. */
const mineOf = (scope: WorkScope) => (r: WorkLogRow) => scope.view === "organisation" || r.brandId === scope.session.id;

/**
 * What Carry over logs today for this person: carryOverOn's workstreams that they can log, each
 * with the region its entry is kept in. A brand's comes from the registry; a whole business one is
 * kept where its newest entry is, so whoever carries it, from any brand, writes the same row.
 */
function carryable(scope: WorkScope, rows: readonly WorkLogRow[], today: string, readFrom: string): Array<{ f: InFlight; region: Region }> {
  const regionOf = new Map(rows.map((r) => [r.id, r.region]));
  const out: Array<{ f: InFlight; region: Region }> = [];
  for (const f of carryOverOn(rows, today, scope.session.timeZone, readFrom)) {
    if (f.brandId === null) {
      const region = regionOf.get(f.id);
      if (scope.view === "organisation" && region) out.push({ f, region });
      continue;
    }
    const b = brandIn(scope, f.brandId);
    if (b && (scope.view === "organisation" || b.id === scope.session.id)) out.push({ f, region: b.region });
  }
  return out;
}

/**
 * A carried entry's id, worked out from the organisation, the day and the workstream: whoever taps
 * Carry over, and however often, today's entry for a workstream has one id, which the store writes
 * once (appendWorkLogOnce).
 */
export function carriedEntryId(organisationId: string, day: string, f: Pick<InFlight, "brandId" | "workstream">): string {
  return `wl_${createHash("sha256").update(`${CARRY_TOOL}\n${organisationId}\n${day}\n${workstreamKey(f)}`).digest("hex").slice(0, 24)}`;
}

/** A value that may hold a check with a purpose's count (units) on it. */
function withoutUnits(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const counted = (v as { counted?: { units?: unknown } | null }).counted;
  return counted && counted.units !== undefined ? { ...(v as Record<string, unknown>), counted: null } : v;
}

/** A typed links value, before or after, without its loop lines. */
function linksWithoutLoopLines(v: unknown): unknown {
  return Array.isArray(v) ? withoutLoopLines(v as Array<{ kind: string }>) : v;
}

/**
 * A row as someone who isn't an operator gets it: a count of this copy's own purposes (units),
 * kept on a read's row or in a check's value before and after, and a loop line link in a typed
 * links change, are for operators only (decision 14).
 */
export function rowForViewer(scope: Pick<WorkScope, "operator">, row: WorkLogRow): WorkLogRow {
  if (scope.operator) return row;
  if (row.kind === "check" && row.check.counted?.units !== undefined) return { ...row, check: { ...row.check, counted: null } };
  if (row.kind === "change" && row.field === "check") return { ...row, before: withoutUnits(row.before), after: withoutUnits(row.after) };
  if (row.kind === "change" && row.field === "typedLinks") return { ...row, before: linksWithoutLoopLines(row.before), after: linksWithoutLoopLines(row.after) };
  return row;
}

/** One day of the Log, today unless a day is given (never one after today). */
export async function logDay(scope: WorkScope, day: string | null, deps: WorkDeps = {}): Promise<WorkResult<LogDayView>> {
  const now = nowOf(deps);
  const tz = scope.session.timeZone;
  const today = dayIn(now, tz);
  const shown = day ?? today;
  if (!isDay(shown) || shown > today || shown < addDaysToKey(today, -366)) return refuse("day_bad");
  const { readFrom, from, to } = logWindow(shown, tz);
  // The day rail always ends today: a past day reads the rail's own 14 days beside its own rows.
  const railFrom = new Date(wallTimeToUtc(addDaysToKey(today, -(LOG_RAIL_DAYS - 1)), 0, 0, tz)).toISOString();
  const railTo = new Date(wallTimeToUtc(addDaysToKey(today, 1), 0, 0, tz)).toISOString();
  const [read, loaded, checks, railRead] = await Promise.all([
    listWorkLog(scope.organisationId, { from, to, limit: LOG_ROWS }, deps),
    loadTasks(scope, { brandId: scope.view === "brand" ? scope.session.id : undefined, allClosed: false }, deps),
    shown === today ? dueChecks(scope, deps) : Promise.resolve({ tasks: [], regionsDown: [] }),
    shown === today ? Promise.resolve(null) : listWorkLog(scope.organisationId, { from: railFrom, to: railTo, limit: LOG_ROWS }, deps),
  ]);
  const mine = mineOf(scope);
  const rows = read.rows.filter(mine).map((r) => rowForViewer(scope, r));
  const derived = deriveDay(rows, shown, tz, readFrom);
  if (railRead) derived.rail = railDays(railRead.rows.filter(mine), today, tz);
  const tasks: LogDayView["tasks"] = {};
  for (const t of loaded.tasks) if (seesTask(scope, t)) tasks[t.id] = { ref: t.ref, title: t.title, status: t.status, brandId: t.brandId };
  // A task deleted since keeps its ref and title in its added row.
  for (const r of rows) {
    if (r.kind !== "change" || (r.field !== "added" && r.field !== "deleted") || tasks[r.taskId]) continue;
    const snap = (r.field === "added" ? r.after : r.before) as { ref?: unknown; title?: unknown; status?: unknown } | null;
    if (snap && typeof snap.ref === "number" && typeof snap.title === "string") tasks[r.taskId] = { ref: snap.ref, title: snap.title, status: (snap.status as WorkStatus) ?? "todo", brandId: r.brandId };
  }
  // Each approved plan by its title on the task, when the task was read; the Log falls back to its host.
  const planTitles: LogDayView["planTitles"] = {};
  const approved = new Set(derived.decisions.flatMap((d) => (d.decision.plan ? [planKeyOf(d.decision.plan.url, d.decision.plan.version)] : [])));
  if (approved.size) {
    for (const t of loaded.tasks) {
      if (!seesTask(scope, t)) continue;
      for (const l of t.typedLinks) if (l.kind === "plan" && approved.has(planKeyOf(l.url, l.version))) planTitles[planKeyOf(l.url, l.version)] = l.title;
    }
  }
  const down = new Set([...read.unanswered, ...loaded.unanswered, ...(railRead?.unanswered ?? [])]);
  return ok({
    ...derived,
    today: shown === today,
    timeZone: tz,
    tasks,
    planTitles,
    checks: checks.tasks,
    regionsDown: [...new Set([...down, ...checks.regionsDown.map((d) => d.region)])].map((r) => ({ region: r, name: REGION_CONFIGS[r].displayName })),
    // Each region's read stops at LOG_ROWS on its own: rows from several regions can add up past it with none cut.
    capped: read.full.length > 0,
    carry: shown === today && !read.unanswered.length ? carryable(scope, rows, today, readFrom).length : 0,
  });
}

/**
 * Carry over on Today (plan section 8.3, the approved canvas): one tap logs today's entry for each
 * workstream still open from yesterday that nobody has logged today, by the person who tapped. Each
 * is an ordinary entry, with yesterday's state, task and links and the note "Carried over from
 * yesterday.", and yesterday's entry stays as it was, so the Log keeps both. Only today: the page's
 * day must be today in the session brand's time zone, so a past day stays read only and a page left
 * open past midnight carries nothing. Nothing is carried while a region doesn't answer, since an
 * entry kept there may already say the workstream is done. Tapped twice, or by two people at once,
 * each entry is written once (carriedEntryId). Answers the entries it wrote.
 */
export async function carryOver(scope: WorkScope, body: CarryBody, deps: WorkDeps = {}): Promise<WorkResult<{ carried: Array<WorkLogRowOf<"entry">> }>> {
  const now = nowOf(deps);
  const tz = scope.session.timeZone;
  const today = dayIn(now, tz);
  if (!isDay(body.day) || body.day > today) return refuse("day_bad");
  if (body.day < today) return refuse("carry_day_over");
  const { readFrom, from, to } = logWindow(today, tz);
  const read = await listWorkLog(scope.organisationId, { from, to, limit: LOG_ROWS }, deps);
  if (read.unanswered.length) return refuse("carry_regions_down");
  const open = carryable(scope, read.rows.filter(mineOf(scope)), today, readFrom);
  if (!open.length) return ok({ carried: [] });
  if ((await entriesToday(scope, today, deps)) + open.length > WORK_LIMITS.entriesPerDay) return refuse("entries_full");
  const at = now.toISOString();
  const written = await appendWorkLogOnce(
    open.map(({ f, region }) => ({
      id: carriedEntryId(scope.organisationId, today, f),
      organisationId: scope.organisationId,
      brandId: f.brandId,
      region,
      day: today,
      at,
      source: { who: { kind: "person" as const, id: scope.userId }, tool: CARRY_TOOL, session: null },
      kind: "entry" as const,
      taskId: f.taskId,
      workstream: f.workstream,
      state: f.state,
      note: CARRIED_NOTE,
      links: f.links,
    })),
    deps,
  );
  return ok({ carried: written as Array<WorkLogRowOf<"entry">> }, written.length ? 201 : 200);
}

/**
 * Log an entry for today: a workstream with its state, an optional note and links, and the task
 * it is about. Members log for their own brand; others for the brand they name, the session
 * brand, or the whole business. At most 500 entries a day for the organisation. Saved from a draft
 * of Vizzy's, the row and the draft's move are written together (src/lib/work/drafts.ts).
 */
export async function addLogEntry(scope: WorkScope, body: LogEntryBody, deps: WorkDeps = {}, opts: { draft?: DraftedSave } = {}): Promise<WorkResult<{ row: WorkLogRowOf<"entry"> }>> {
  const now = nowOf(deps);
  let place = placeForNew(scope, body.brandId === undefined ? scope.session.id : body.brandId);
  let taskId: string | null = null;
  if (body.ref !== undefined) {
    const { task } = await findWorkTaskByRef(scope.organisationId, body.ref, deps);
    if (!task || !seesTask(scope, task)) return refuse("not_found");
    taskId = task.id;
    place = { brandId: task.brandId, region: task.region };
  }
  if ("error" in place) return place;
  const day = dayIn(now, scope.session.timeZone);
  if ((await entriesToday(scope, day, deps)) >= WORK_LIMITS.entriesPerDay) return refuse("entries_full");
  const entry = {
    organisationId: scope.organisationId,
    brandId: place.brandId,
    region: place.region,
    day,
    at: now.toISOString(),
    source: { who: { kind: "person" as const, id: scope.userId }, tool: opts.draft?.tool ?? "work_log", session: null },
    kind: "entry" as const,
    taskId,
    workstream: body.workstream,
    state: body.state,
    note: body.note ?? "",
    links: body.links ?? [],
  };
  if (opts.draft) {
    const saved = await saveDraftedWorkLog(scope.ctx, { ...entry, id: opts.draft.rowId }, opts.draft.accept, deps);
    if (!saved.ok) return draftRefusal(saved.error);
    return ok({ row: saved.row as WorkLogRowOf<"entry"> }, 201);
  }
  const [row] = await appendWorkLog([entry], deps);
  return ok({ row: row as WorkLogRowOf<"entry"> }, 201);
}
