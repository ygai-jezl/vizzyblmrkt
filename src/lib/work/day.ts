import { addDaysToKey } from "@/lib/lifecycle/sendWindow";
import { dayIn } from "./schedule";
import type { EntryState, WorkLink, WorkLogRow, WorkLogRowOf, WorkWho } from "./types";

/**
 * A day of the Log (ADR-0020, plan decision 4): stored entries, derived day. Nothing here is a
 * lane or a snapshot; it is all worked out from the log rows when the Log is read.
 *
 * - In flight: each workstream (by brand and name, ignoring case) whose newest entry up to the end
 *   of the day isn't Done. It carries over day to day by itself, never retyped, with "Day N"
 *   counted from the first entry since it was last Done.
 * - Moved: the tasks that changed that day (change and check rows), each with its rows. Work's own
 *   counting is not a move.
 * - Decisions: the decisions recorded that day, plan approvals among them.
 * - The day rail: for each of the last 14 days, how many entries, tasks moved and decisions.
 *
 * Days are the viewer's brand's days. Pure.
 */

/** How many days back the Log reads to find what is still in flight. */
export const LOG_LOOKBACK_DAYS = 30;
/** How many days the day rail shows: today and the 13 before it, whichever day is shown. */
export const LOG_RAIL_DAYS = 14;

export interface InFlight {
  workstream: string;
  brandId: string | null;
  state: Exclude<EntryState, "done">;
  note: string;
  links: WorkLink[];
  /** Who wrote the newest entry. */
  by: WorkWho;
  at: string;
  taskId: string | null;
  /** The day of the first entry since it was last Done, and Day N from it. */
  since: string;
  dayN: number;
  /** It started before the days the Log read, so Day N is at least this. */
  longer: boolean;
}

export interface MovedTask {
  taskId: string;
  rows: Array<WorkLogRowOf<"change"> | WorkLogRowOf<"check">>;
  /** The newest row's time. */
  at: string;
}

export interface RailDay {
  day: string;
  entries: number;
  moved: number;
  decisions: number;
}

export interface LogDay {
  day: string;
  entries: Array<WorkLogRowOf<"entry">>;
  inFlight: InFlight[];
  moved: MovedTask[];
  decisions: Array<WorkLogRowOf<"decision">>;
  rail: RailDay[];
}

/** Work's own writes that aren't a person's or Vizzy's move: the count kept on a check. */
const NOT_A_MOVE = new Set(["work_count"]);

const keyOf = (r: WorkLogRowOf<"entry">) => `${r.brandId ?? ""}|${r.workstream.trim().toLowerCase().replace(/\s+/g, " ")}`;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** What was in flight at the end of `day`: from entries on or before it. */
export function inFlightOn(rows: readonly WorkLogRow[], day: string, timeZone: string, readFrom: string): InFlight[] {
  const byKey = new Map<string, Array<WorkLogRowOf<"entry">>>();
  for (const r of rows) {
    if (r.kind !== "entry" || dayIn(r.at, timeZone) > day) continue;
    const k = keyOf(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: InFlight[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const newest = list[list.length - 1]!;
    if (newest.state === "done") continue;
    let first = list.length - 1;
    while (first > 0 && list[first - 1]!.state !== "done") first -= 1;
    const since = dayIn(list[first]!.at, timeZone);
    const longer = first === 0 && since <= readFrom;
    out.push({
      workstream: newest.workstream,
      brandId: newest.brandId,
      state: newest.state,
      note: newest.note,
      links: newest.links,
      by: newest.source.who,
      at: newest.at,
      taskId: newest.taskId ?? list.slice(first).reverse().find((r) => r.taskId)?.taskId ?? null,
      since,
      dayN: daysBetween(since, day) + 1,
      longer,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.workstream.localeCompare(b.workstream));
}

/** The Log for one day, from the rows read (newest first or any order), and the rail's days. */
export function deriveDay(rows: readonly WorkLogRow[], day: string, timeZone: string, readFrom: string): LogDay {
  const on = (r: WorkLogRow) => dayIn(r.at, timeZone) === day;
  const entries = rows.filter((r): r is WorkLogRowOf<"entry"> => r.kind === "entry" && on(r)).sort((a, b) => b.at.localeCompare(a.at));
  const decisions = rows.filter((r): r is WorkLogRowOf<"decision"> => r.kind === "decision" && on(r)).sort((a, b) => b.at.localeCompare(a.at));
  const movedBy = new Map<string, MovedTask>();
  for (const r of rows) {
    if ((r.kind !== "change" && r.kind !== "check") || !on(r) || NOT_A_MOVE.has(r.source.tool)) continue;
    const m = movedBy.get(r.taskId) ?? { taskId: r.taskId, rows: [], at: r.at };
    m.rows.push(r);
    if (r.at > m.at) m.at = r.at;
    movedBy.set(r.taskId, m);
  }
  // A task's rows oldest first; in the same moment its added row first.
  const firstOf = (r: MovedTask["rows"][number]) => (r.kind === "change" && r.field === "added" ? 0 : 1);
  const moved = [...movedBy.values()]
    .map((m) => ({ ...m, rows: m.rows.sort((a, b) => a.at.localeCompare(b.at) || firstOf(a) - firstOf(b)) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.taskId.localeCompare(b.taskId));
  return { day, entries, inFlight: inFlightOn(rows, day, timeZone, readFrom), moved, decisions, rail: railDays(rows, day, timeZone) };
}

/** The day rail: `end` and the 13 days before it, newest first, each with what happened on it. */
export function railDays(rows: readonly WorkLogRow[], end: string, timeZone: string): RailDay[] {
  const rail: RailDay[] = [];
  for (let i = 0; i < LOG_RAIL_DAYS; i++) {
    const d = addDaysToKey(end, -i);
    const of = rows.filter((r) => dayIn(r.at, timeZone) === d);
    rail.push({
      day: d,
      entries: of.filter((r) => r.kind === "entry").length,
      moved: new Set(of.filter((r) => (r.kind === "change" || r.kind === "check") && !NOT_A_MOVE.has(r.source.tool)).map((r) => r.taskId)).size,
      decisions: of.filter((r) => r.kind === "decision").length,
    });
  }
  return rail;
}
