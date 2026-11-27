import { activePlanOf } from "@/lib/plans/catalog";
import { isPlansEnabled, isUsageMeterEnabled } from "@/lib/plans/flags";
import { meterMonth, usageThisMonth } from "@/lib/plans/meter";
import { addToFleetCells, FLEET_WRITE_MAX, fleetCellId } from "@/lib/tenant/fleetCells";
import { laneMarkId, readLaneMarkTx, runLaneTransaction, writeLaneMarkTx } from "@/lib/tenant/loopLane";
import { isoWeekStart, loopDayId, mergeLaneState, readLoopDays } from "@/lib/tenant/loops";
import type { TenantPageRow } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { FLEET_ROWS } from "@/lib/types/fleetCell";
import { BEAT_KINDS_MAX, type BrandPointers, type CounterTree, type LaneState } from "@/lib/types/loopDay";
import { MARK_CELLS_MAX, MARK_KEY_CHARS, MARK_OUTPUTS_MAX, type LaneMark } from "@/lib/types/loopLane";
import type { Tenant } from "@/lib/types/tenant";
import type { ResourceCount } from "@/lib/types/usageMeter";
import { isLoopsEnabled } from "./flags";
import { lastClosedWeek, weekAfter, weekBefore } from "./fold";
import { industryOf } from "./industry";
import { IMAGE_STYLE_SCOPES, LOOP_RULES } from "./registry";
import { HOLDBACK_ARMS, IMAGE_POOL, looksInUse, rowKindOf, rowsOfWeek, rowStage, STAGE_WEEKS, stagesThrough, type LookInUse, type RowWeek } from "./stages";
import { stampedOf, tallyByKind, unusedForWeek } from "./tally";

/**
 * The heartbeat (learning loops step 5, 4.6 of the plan for steps 4 and 5): once a week is closed
 * and folded, the lane reports each brand's week to the counts across brands (`fleet_cells`),
 * counting organisations, never brands, and never images, words or people. With LOOPS_ENABLED
 * off nothing here runs, and a brand that opted out sends nothing.
 *
 * For a closed week W, per brand:
 * 1. Its report (brandWeekReport, pure): the cells its organisation counts in (its stage on each
 *    kind over the 4 weeks to W, where it is stuck, its learners' refusals, its Go back cards and
 *    its wait for a check, by plan and by industry), and its counts of things in W, capped later.
 * 2. Its lane state (`ls:`) records W first: a run cut off after this undercounts, and a rerun
 *    never reports W again.
 * 3. One transaction on its organisation's mark in `loop_lane` (creditMark): a report for the
 *    mark's week adds only cells not yet credited and outputs up to LOOP_RULES.orgOutputsCap for
 *    each kind and signal across arms (and each image style), scaled together so their shares
 *    hold; one for a newer week replaces the mark; one for an older week is dropped and counted
 *    late. So an organisation with two brands counts once, and nothing counts twice.
 * 4. Its credited increments go to the run's FleetBuffer, which the lane writes in one batched
 *    write at the end of the run: a run cut off before then undercounts.
 *
 * Every read is bounded: the 4 to 5 folded weeks the window needs, the learned versions in use
 * (at most 8), and the usage meter's month (2 at a month's turn). Server only.
 */

const DAY_MS = 86_400_000;

/** How many closed weeks a visit reports at most, and how far back a brand that fell behind starts. */
export const HEARTBEAT = {
  WEEKS_PER_VISIT: 2,
  CATCH_UP_WEEKS: 4,
} as const;

type Counts = Record<string, number>;
type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A part of a cell's key: what a counter key of the counts across brands may hold (src/lib/tenant/fleetCells.ts). */
const KEY_PART = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * A cell's key, `<row>/<path>`, as the marks keep it and the buffer turns it into a row's counts:
 * the row is a kind (or its pool) or one of the copy's own rows. Null for a part that can't be one.
 */
export function cellKey(row: string, ...path: string[]): string | null {
  if (!KEY_PART.test(row) || path.length === 0 || !path.every((p) => KEY_PART.test(p))) return null;
  const key = [row, ...path].join("/");
  return key.length <= MARK_KEY_CHARS ? key : null;
}

/** The plan a brand counts under: granted when it has granted features, otherwise its plan, otherwise open. */
export function planKeyOf(row: Pick<TenantPageRow, "grantedFeatures" | "orgPlan">): string {
  if (row.grantedFeatures.length > 0) return "granted";
  return activePlanOf({ orgPlan: row.orgPlan ?? undefined } as Pick<Tenant, "orgPlan">, isPlansEnabled())?.id ?? "open";
}

/** Whether the brand record still holds a look from before versions. */
export const holdsOldLook = (row: Pick<TenantPageRow, "learnedImageStyle" | "styleLooks">): boolean =>
  Boolean(row.learnedImageStyle) || Object.values(row.styleLooks).some((l) => Boolean(l.directive));

// ----- 1. A brand's report for one week (pure) -----

export interface WeekReportInput {
  week: string;
  /** The folded weeks (`lt:` data) of the window, oldest first, the reported week last: STAGE_WEEKS of them, undefined for a week with no counts. */
  window: readonly unknown[];
  /** The learned looks the brand uses (the image pool's Learning, Checked and wait). */
  looks: readonly LookInUse[];
  plan: string;
  industry: string;
  /** AI calls by purpose since the brand's last report (the newest week reported only). */
  calls: Counts;
  oldCopy: boolean;
  /** The window's weeks already read by row (rowsOfWeek), in the same order, so a visit reporting 2 weeks reads each once. */
  rows?: ReadonlyArray<Map<string, RowWeek>>;
}

export interface WeekReport {
  week: string;
  /** Cells that count organisations, credited once per organisation a week. */
  orgCells: string[];
  /** Counts of things in the week, capped per organisation a cell when credited. */
  things: Counts;
  /** Counts added as they are, never through the mark: brands reported, and calls. */
  plain: Counts;
  /** For `ls:`: each row's furthest step (`row:step`) and where it is stuck. */
  reached: string[];
  stuck: string[];
}

/** Things with any count in a week. */
function hasCounts(w: RowWeek | undefined): boolean {
  if (!w) return false;
  return (
    w.made !== 0 ||
    w.signals !== 0 ||
    w.learned !== 0 ||
    w.noDraft !== 0 ||
    [w.refused, w.own, w.liked, w.disliked, w.declinedWhy, w.unstamped, w.cards].some((c) => Object.keys(c).length > 0)
  );
}

/**
 * Scale a kind's coverage to at most the cap in all, so its share holds while one busy organisation
 * can't outweigh the rest. A save with no stamp, or a lost stamp, never scales away to nothing, and
 * the three together stay within the cap, so the mark adds them as they are.
 */
function scaledCoverage(stamped: number, unstamped: number, lost: number, cap: number): Counts {
  const all = stamped + unstamped + lost;
  if (all <= cap) return { stamped, unstamped, lost };
  const f = cap / all;
  const keep = (n: number) => (n > 0 ? Math.max(1, Math.round(n * f)) : 0);
  const u = keep(unstamped);
  const l = keep(lost);
  return { stamped: Math.max(0, Math.min(Math.round(stamped * f), cap - u - l)), unstamped: u, lost: l };
}

/** The brand's report for one closed week. */
export function brandWeekReport(input: WeekReportInput): WeekReport {
  const weeks = input.rows && input.rows.length === input.window.length ? input.rows : input.window.map((d) => rowsOfWeek(d));
  const current = weeks[weeks.length - 1] ?? new Map<string, RowWeek>();
  const rows = new Set<string>();
  for (const m of weeks) for (const r of m.keys()) rows.add(r);
  if (input.looks.length) rows.add(IMAGE_POOL);
  const weekEnd = new Date(isoWeekStart(input.week).getTime() + 7 * DAY_MS);
  const cap = LOOP_RULES.orgOutputsCap;

  const orgCells = new Set<string>();
  const things: Counts = {};
  const plain: Counts = {};
  const org = (row: string, ...path: string[]) => {
    const k = cellKey(row, ...path);
    if (k) orgCells.add(k);
  };
  /** Rows this report adds a number of things to: their organisations this week (`<row>/week/orgs`) floor those numbers. */
  const withThings = new Set<string>();
  const thing = (n: number, row: string, ...path: string[]) => {
    const k = n > 0 ? cellKey(row, ...path) : null;
    if (!k) return;
    things[k] = (things[k] ?? 0) + Math.floor(n);
    withThings.add(row);
  };
  const flat = (n: number, row: string, ...path: string[]) => {
    const k = n > 0 ? cellKey(row, ...path) : null;
    if (k) plain[k] = (plain[k] ?? 0) + Math.floor(n);
  };

  // Declared: the organisations that sent a heartbeat, by plan and industry.
  org(FLEET_ROWS.orgs, "orgs");
  org(FLEET_ROWS.orgs, "p", input.plan);
  org(FLEET_ROWS.orgs, "i", input.industry);
  flat(1, FLEET_ROWS.orgs, "reported");
  if (input.oldCopy) flat(1, FLEET_ROWS.orgs, "oldCopy");

  // Coverage, by row: stamped saves against those with no stamp or a lost one.
  const coverage = new Map<string, { s: number; u: number; l: number }>();
  for (const [kind, t] of tallyByKind(input.window[input.window.length - 1])) {
    const row = rowKindOf(kind);
    if (!row) continue;
    const c = coverage.get(row) ?? { s: 0, u: 0, l: 0 };
    // A thing counted made and records_off (or stamp_lost) beside it is one thing, not stamped.
    c.s += stampedOf(t);
    c.u += Math.max(0, t.unstamped);
    c.l += Math.max(0, t.lost);
    coverage.set(row, c);
  }
  // Unused: made in the week two before, with nothing kept, edited or declined since.
  const unused = new Map<string, number>();
  for (const [kind, n] of unusedForWeek(input.window.slice(-3))) {
    const row = rowKindOf(kind);
    if (row) unused.set(row, (unused.get(row) ?? 0) + n);
  }

  const reached: string[] = [];
  const stuck: string[] = [];
  for (const row of [...rows].sort()) {
    const st = rowStage(
      row,
      weeks.map((m) => m.get(row)),
      row === IMAGE_POOL ? input.looks : [],
      weekEnd,
    );
    const w = current.get(row);
    if (!st.reached && !hasCounts(w) && Object.keys(st.refused).length === 0 && !st.card && st.waitDays === null) continue;

    // Counts of organisations: the window's. Each step counts the organisation once (`all`), and
    // once under its brand's plan and industry, so a plan row can hold an organisation two of
    // whose brands are on different plans without the kind's total counting it twice.
    org(row, "orgs");
    for (const s of stagesThrough(st.reached)) {
      org(row, "st", s, "all");
      org(row, "st", s, "p", input.plan);
      org(row, "st", s, "i", input.industry);
    }
    if (st.reached) reached.push(`${row}:${st.reached}`);
    if (st.stuck) {
      // Once in all, as the steps are, so an organisation stuck on brands of two plans counts once.
      org(row, "stuck", st.stuck, "all");
      org(row, "stuck", st.stuck, "p", input.plan);
      if (st.topReason) org(row, "stuck", st.stuck, "why", input.plan, st.topReason);
      // Stuck at Stamped with posts that went out with no AI draft kept: nothing could count as kept or edited (4.4).
      if (st.stuck === "stamped" && st.noDraft > 0) org(row, "stuck", st.stuck, "nodraft");
      stuck.push(`${row}:${st.stuck}`);
    }
    for (const [reason, n] of Object.entries(st.refused)) {
      if (n <= 0) continue;
      org(row, "refused", reason);
      // And once for the copy, however many kinds refused it for that reason.
      org(FLEET_ROWS.orgs, "refused", reason);
    }
    if (st.card) org(row, "cards", "orgs");
    if (st.waitDays !== null) {
      org(row, "wait", "orgs");
      org(row, "wait", "m", `m${Math.min(24, Math.floor(st.waitDays / 30))}`);
    }

    // Counts of things: the week's own.
    if (w) {
      for (const [arm, signals] of Object.entries(w.out)) for (const [s, n] of Object.entries(signals)) thing(n, row, "out", arm, s);
      for (const [style, byArm] of Object.entries(w.scope)) {
        let used = false;
        for (const [arm, signals] of Object.entries(byArm)) {
          for (const [s, n] of Object.entries(signals)) {
            thing(n, row, "scope", style, arm, s);
            if (n > 0 && HOLDBACK_ARMS.has(arm)) used = true;
          }
        }
        // The organisations behind each style's holdback line, so a style shows only from 10 of
        // them: only counts in the arms the line adds up (a learned look, or held back from one).
        if (used) org(row, "styles", style);
      }
      thing(w.noDraft, row, "nodraft");
      for (const [s, n] of Object.entries(w.own)) thing(n, row, "own", s);
      for (const [r, n] of Object.entries(w.liked)) thing(n, row, "why", "liked", r);
      for (const [r, n] of Object.entries(w.disliked)) thing(n, row, "why", "disliked", r);
      for (const [why, n] of Object.entries(w.declinedWhy)) thing(n, row, "declined", why);
      for (const [r, n] of Object.entries(w.unstamped)) thing(n, row, "u", r);
      for (const [s, n] of Object.entries(w.cards)) thing(n, row, "cards", s);
    }
    const c = coverage.get(row);
    if (c && c.s + c.u + c.l > 0) for (const [k, n] of Object.entries(scaledCoverage(c.s, c.u, c.l, cap))) thing(n, row, "cov", k);
    thing(unused.get(row) ?? 0, row, "unused");
    // The organisations whose week has numbers of things in this row: the floor for those numbers.
    if (withThings.has(row)) org(row, "week", "orgs");
  }

  // Made per ontology type, with organisations.
  const lastWeek = input.window[input.window.length - 1];
  const types = isObj(lastWeek) && isObj(lastWeek.t) ? lastWeek.t : {};
  for (const [type, counts] of Object.entries(types)) {
    const n = isObj(counts) ? num(counts.made) : 0;
    if (n <= 0) continue;
    thing(n, FLEET_ROWS.types, "made", type);
    org(FLEET_ROWS.types, "orgs", type);
  }
  // Calls per purpose, with organisations: uses, so never capped.
  for (const [purpose, n] of Object.entries(input.calls)) {
    if (n <= 0) continue;
    flat(n, FLEET_ROWS.calls, "calls", purpose);
    org(FLEET_ROWS.calls, "orgs", purpose);
  }
  return { week: input.week, orgCells: [...orgCells], things, plain, reached: reached.slice(0, BEAT_KINDS_MAX), stuck: stuck.slice(0, BEAT_KINDS_MAX) };
}

// ----- 3. The organisation's mark (pure) -----

export type MarkCredit = { late: true } | { late: false; mark: LaneMark; orgCells: string[]; things: Counts };

/**
 * The budget an output counts against, and the group whose outputs scale together (4.6, the cap
 * of LOOP_RULES.orgOutputsCap): a kind's outputs by arm (`<row>/out/<arm>/<signal>`) share one
 * budget for each signal across the arms, so its made counts at most the cap however it was made;
 * the reasons given with its votes (`<row>/why/<direction>/<reason>`) scale with those outputs, on
 * one budget per direction, so reasons never outgrow the thumbs down they explain; an image
 * style's (`<row>/scope/<style>/<arm>/<signal>`) the same for each style; coverage
 * (`<row>/cov/<k>`) one budget in all; any other output is its own. Budgets are kept on the mark
 * only, never sent: a `*` in their keys, which no cell has, keeps them apart.
 */
export function budgetOf(key: string): { group: string; budget: string } {
  const p = key.split("/");
  if (p.length === 4 && p[1] === "out") return { group: `${p[0]}/out`, budget: `${p[0]}/out/*/${p[3]}` };
  if (p.length === 4 && p[1] === "why") return { group: `${p[0]}/out`, budget: `${p[0]}/why/${p[2]}/*` };
  if (p.length === 5 && p[1] === "scope") return { group: `${p[0]}/scope/${p[2]}`, budget: `${p[0]}/scope/${p[2]}/*/${p[4]}` };
  if (p.length === 3 && p[1] === "cov") return { group: `${p[0]}/cov`, budget: `${p[0]}/cov/*` };
  return { group: key, budget: key };
}

/**
 * Credit one brand's report to its organisation's mark: a mark for a newer week drops the report
 * (late); one for the same week adds only cells not yet credited and outputs up to `cap` against
 * each budget (budgetOf); an older mark, or none, starts the week afresh. A group's outputs scale
 * by one factor, from the budget with least room against what the report brings it, so liked
 * against voted, or kept against made, reads the same capped as uncapped. A mark never grows past
 * its bounds: a cell or output past them is left out, which can only undercount.
 */
export function creditMark(mark: LaneMark | null, report: Pick<WeekReport, "week" | "orgCells" | "things">, at: string, cap: number = LOOP_RULES.orgOutputsCap): MarkCredit {
  if (mark && mark.week > report.week) return { late: true };
  const same = mark && mark.week === report.week ? mark : null;
  const cells = new Set(same?.cells ?? []);
  const outputs: Counts = { ...(same?.outputs ?? {}) };
  let outputKeys = Object.keys(outputs).length;
  const orgCells: string[] = [];
  const things: Counts = {};
  for (const k of report.orgCells) {
    if (cells.has(k) || cells.size >= MARK_CELLS_MAX || k.length > MARK_KEY_CHARS) continue;
    cells.add(k);
    orgCells.push(k);
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(outputs, k);
  const groups = new Map<string, Array<{ key: string; n: number; budget: string }>>();
  for (const [key, raw] of Object.entries(report.things)) {
    const n = Math.floor(raw);
    if (key.length > MARK_KEY_CHARS || !(n > 0)) continue;
    const { group, budget } = budgetOf(key);
    const items = groups.get(group) ?? groups.set(group, []).get(group)!;
    items.push({ key, n, budget });
  }
  for (const items of groups.values()) {
    const want = new Map<string, number>();
    for (const { n, budget } of items) want.set(budget, (want.get(budget) ?? 0) + n);
    let f = 1;
    let fresh = 0;
    for (const [budget, n] of want) {
      if (!has(budget)) fresh += 1;
      f = Math.min(f, Math.max(0, cap - (outputs[budget] ?? 0)) / n);
    }
    // A group whose budgets the mark can't hold is left out whole, so its shares never skew.
    if (!(f > 0) || outputKeys + fresh > MARK_OUTPUTS_MAX) continue;
    for (const { key, n, budget } of items) {
      const add = Math.floor(n * f);
      if (!(add > 0)) continue;
      if (!has(budget)) outputKeys += 1;
      outputs[budget] = (outputs[budget] ?? 0) + add;
      things[key] = (things[key] ?? 0) + add;
    }
  }
  return { late: false, mark: { week: report.week, cells: [...cells], outputs, at }, orgCells, things };
}

// ----- 4. The run's increments -----

/** A row's id for a cell key's row and a week, or null for a row that can't be one. */
function rowIdOf(row: string, week: string): string | null {
  try {
    if (row === FLEET_ROWS.orgs) return fleetCellId.orgs(week);
    if (row === FLEET_ROWS.types) return fleetCellId.types(week);
    if (row === FLEET_ROWS.calls) return fleetCellId.calls(week);
    return fleetCellId.kind(row, week);
  } catch {
    return null;
  }
}

/**
 * One run's credited increments across brands, added up by row, and written once at the end of
 * the run (flush) in batches of at most FLEET_WRITE_MAX rows. Small: counts only.
 */
export class FleetBuffer {
  private readonly rows = new Map<string, CounterTree>();

  /** Add `n` to a cell (`<row>/<path>`) of the week's row. */
  add(week: string, key: string, n: number): void {
    if (!Number.isInteger(n) || n <= 0) return;
    const [row, ...path] = key.split("/");
    if (!row || path.length === 0) return;
    const id = rowIdOf(row, week);
    if (!id) return;
    let tree = this.rows.get(id);
    if (!tree) this.rows.set(id, (tree = {}));
    let at: CounterTree = tree;
    for (const part of path.slice(0, -1)) {
      const next = at[part];
      if (typeof next === "number") return;
      at = (next ?? (at[part] = {})) as CounterTree;
    }
    const leaf = path[path.length - 1]!;
    const was = at[leaf];
    if (was !== undefined && typeof was !== "number") return;
    at[leaf] = (was ?? 0) + n;
  }

  /** Rows with counts not yet written. */
  get size(): number {
    return this.rows.size;
  }

  /** The rows as they would be written. */
  cells(): Array<{ id: string; n: CounterTree }> {
    return [...this.rows].map(([id, n]) => ({ id, n }));
  }

  /** Write every row's counts, FLEET_WRITE_MAX rows a call, and empty the buffer. Never throws; answers the rows written. */
  async flush(db?: FirestoreLike): Promise<number> {
    const all = this.cells();
    this.rows.clear();
    let written = 0;
    for (let i = 0; i < all.length; i += FLEET_WRITE_MAX) {
      try {
        written += await addToFleetCells(all.slice(i, i + FLEET_WRITE_MAX), db);
      } catch (err) {
        // A run's counts across brands that can't be written are let go: an undercount, never twice.
        console.warn("[loops] adding to the counts across brands failed", err instanceof Error ? err.message.slice(0, 200) : "error");
      }
    }
    return written;
  }
}

// ----- 2 and 3: a brand's heartbeat -----

/** The closed weeks a brand reports next, oldest first: after its last, through its last folded, at most HEARTBEAT.WEEKS_PER_VISIT. */
export function weeksToReport(lastReported: string | undefined, foldedThrough: string | undefined, now: Date): string[] {
  if (!foldedThrough) return [];
  const lastClosed = lastClosedWeek(now);
  const through = foldedThrough < lastClosed ? foldedThrough : lastClosed;
  let floor = through;
  for (let i = 1; i < HEARTBEAT.CATCH_UP_WEEKS; i++) floor = weekBefore(floor);
  // A brand that never reported starts at its newest folded week: weeks before the switch went on aren't counted.
  let start = lastReported ? weekAfter(lastReported) : through;
  if (start < floor) start = floor;
  const weeks: string[] = [];
  for (let w = start; w <= through && weeks.length < HEARTBEAT.WEEKS_PER_VISIT; w = weekAfter(w)) weeks.push(w);
  return weeks;
}

/**
 * Calls by purpose in a month's meter: for each purpose, the most any one resource counted. One
 * call records each resource it spent (a grounded call its searches and its tokens, an image its
 * tokens and the image), so adding them up would count it twice; every AI call records its
 * tokens, failed ones included, so the largest is the number of calls.
 */
function callsIn(meters: Partial<Record<string, ResourceCount>>): Counts {
  const out: Counts = {};
  for (const r of Object.values(meters)) {
    for (const [p, n] of Object.entries(r?.callsByPurpose ?? {})) if (KEY_PART.test(p) && p.length <= 60) out[p] = Math.max(out[p] ?? 0, num(n));
  }
  return out;
}

export interface HeartbeatDeps {
  db?: FirestoreLike;
  controlDb?: FirestoreLike;
  now: Date;
  /** A brand's usage meter for a month (usageThisMonth by default), for tests. */
  usage?: (ctx: TenantContext, month: string) => Promise<Partial<Record<string, ResourceCount>>>;
}

/**
 * Calls by purpose since the brand's last report, and the totals to keep: null with the usage
 * meter off, which writes nothing. A brand's first report counts none and keeps what it saw.
 */
export async function callsSince(ctx: TenantContext, lane: Pick<LaneState, "meterSeen" | "meterMonth">, deps: HeartbeatDeps): Promise<{ delta: Counts; seen: Counts; month: string } | null> {
  if (!isUsageMeterEnabled()) return null;
  const month = meterMonth(deps.now);
  const read = deps.usage ?? ((c: TenantContext, m: string) => usageThisMonth(c, { db: deps.db, month: m }));
  const now = callsIn(await read(ctx, month));
  const seen = lane.meterSeen ?? {};
  const delta: Counts = {};
  const since = (p: string, n: number) => {
    if (n > 0) delta[p] = (delta[p] ?? 0) + Math.floor(n);
  };
  if (lane.meterMonth && lane.meterMonth !== month) {
    // The month turned: the rest of the month seen last, then this month's from nothing.
    const before = callsIn(await read(ctx, lane.meterMonth));
    for (const [p, n] of Object.entries(before)) since(p, n - (seen[p] ?? 0));
    for (const [p, n] of Object.entries(now)) since(p, n);
  } else if (lane.meterMonth) {
    for (const [p, n] of Object.entries(now)) since(p, n - (seen[p] ?? 0));
  }
  // A purpose no longer seen is kept at 0, since a merged write keeps keys it isn't given.
  const next: Counts = Object.fromEntries(Object.keys(seen).map((p) => [p, 0]));
  return { delta, seen: { ...next, ...now }, month };
}

/**
 * What a brand's report may take in (decision 4, and USED_NOTE: nothing is counted across brands
 * while the loops are off or the brand is out). `week`: the first week a report's window holds, the
 * week after its time opted out (`optedOutThrough`), or the first week it reports when it skipped
 * weeks it never reported (the switch was off, or the lane fell more than HEARTBEAT.CATCH_UP_WEEKS
 * behind); null for no limit. `freshCalls`: its calls count as a first report's (none), as its
 * meter's totals since its last report hold calls from that time. Pure.
 */
export function reportsFrom(lane: Pick<LaneState, "heartbeatWeek" | "optedOutThrough">, first: string): { week: string | null; freshCalls: boolean } {
  const out = lane.optedOutThrough ? weekAfter(lane.optedOutThrough) : null;
  const skipped = lane.heartbeatWeek && weekAfter(lane.heartbeatWeek) < first ? first : null;
  const week = [out, skipped].filter((w): w is string => Boolean(w)).sort().pop() ?? null;
  // Just back: the last weeks it marked done were its time out.
  const back = Boolean(lane.optedOutThrough && lane.heartbeatWeek && lane.optedOutThrough >= lane.heartbeatWeek);
  return { week, freshCalls: back || Boolean(skipped) };
}

export interface HeartbeatResult {
  /** Weeks reported this visit, late ones included. */
  weeks: number;
  late: number;
  optedOut?: boolean;
}

/**
 * Report the brand's closed weeks not yet reported, into the run's buffer. Nothing with
 * LOOPS_ENABLED off, or before the week is folded. Never throws for the brand's own trouble.
 */
export async function heartbeat(
  ctx: TenantContext,
  row: TenantPageRow,
  state: { lane: LaneState; pointers: BrandPointers; foldedThrough: string | undefined },
  buffer: FleetBuffer,
  deps: HeartbeatDeps,
): Promise<HeartbeatResult> {
  const none: HeartbeatResult = { weeks: 0, late: 0 };
  if (!isLoopsEnabled()) return none;
  const weeks = weeksToReport(state.lane.heartbeatWeek, state.foldedThrough, deps.now);
  const last = weeks[weeks.length - 1];
  if (!last) return none;
  const warn = (what: string, err: unknown) => console.warn(`[loops] ${what} failed`, err instanceof Error ? err.message.slice(0, 200) : "error");

  // Opted out: nothing of the brand's is sent, and the weeks are marked done, and marked as its
  // time out (optedOutThrough), so a report once it opts back in sends nothing from them. The
  // visit itself counts, as brands listed count every brand, so coverage compares like with like.
  if (state.pointers.fleetOptOut) {
    const kept = await mergeLaneState(ctx, { heartbeatWeek: last, optedOutThrough: last }, deps.db).then(
      () => true,
      (err: unknown) => {
        warn("keeping the heartbeat's week", err);
        return false;
      },
    );
    if (kept) for (const week of weeks) buffer.add(week, `${FLEET_ROWS.orgs}/visited`, 1);
    return { ...none, optedOut: true };
  }

  let markId: string;
  try {
    markId = laneMarkId({ tenantId: row.id, organisationId: row.organisationId });
  } catch (err) {
    warn("naming the organisation's mark", err);
    return none;
  }

  // The window's folded weeks, and the totals of the looks in use, in one batched read.
  let start = weeks[0]!;
  for (let i = 1; i < STAGE_WEEKS; i++) start = weekBefore(start);
  const windowWeeks: string[] = [];
  for (let w = start; w <= last; w = weekAfter(w)) windowWeeks.push(w);
  const from = reportsFrom(state.lane, weeks[0]!);
  // Weeks before `from.week` enter no report: they add no stage, unused thing, refusal or card.
  const readWeeks = from.week ? windowWeeks.filter((w) => w >= from.week!) : windowWeeks;
  const scopes = IMAGE_STYLE_SCOPES.filter((s) => {
    const p = state.pointers.scopes[s];
    return p && p.v >= 1 && p.setBy !== "person";
  });
  let docs: Awaited<ReturnType<typeof readLoopDays>>;
  try {
    docs = await readLoopDays(ctx, [...readWeeks.map((w) => loopDayId.folded(ctx.tenantId, w)), ...scopes.map((s) => loopDayId.version(ctx.tenantId, s, state.pointers.scopes[s]!.v))], deps.db);
  } catch (err) {
    // Nothing is claimed, so the next visit tries the weeks again.
    warn("reading the folded weeks", err);
    return none;
  }
  const folded = new Map(readWeeks.map((w, i) => [w, docs[i]?.d]));
  const totals = new Map(scopes.map((s, i) => [s as string, docs[readWeeks.length + i]?.d]));
  const looks = looksInUse(state.pointers, totals);
  // Back from opting out, or from weeks it never reported: the calls since are its first report's,
  // none, so the meter's totals from that time are kept and never sent.
  const meter = from.freshCalls ? { meterSeen: state.lane.meterSeen } : state.lane;
  const calls = await callsSince(ctx, meter, deps).catch((err) => {
    warn("reading the usage meter", err);
    return null;
  });

  const plan = planKeyOf(row);
  const industry = industryOf(row);
  const oldCopy = holdsOldLook(row);
  // Each folded week is read by row once, however many reports' windows hold it.
  const byRow = new Map(windowWeeks.map((w) => [w, rowsOfWeek(folded.get(w))]));
  const reports = weeks.map((week, i) => {
    const ws: string[] = [];
    let w = week;
    for (let k = 0; k < STAGE_WEEKS; k++, w = weekBefore(w)) ws.unshift(w);
    return brandWeekReport({
      week,
      window: ws.map((x) => folded.get(x)),
      rows: ws.map((x) => byRow.get(x) ?? new Map()),
      looks,
      plan,
      industry,
      calls: i === weeks.length - 1 ? (calls?.delta ?? {}) : {},
      oldCopy,
    });
  });
  byRow.clear();

  // 2. The brand's claim on the weeks, before any mark moves.
  const newest = reports[reports.length - 1]!;
  try {
    await mergeLaneState(
      ctx,
      {
        heartbeatWeek: last,
        beat: { week: last, at: deps.now.toISOString(), reached: newest.reached, stuck: newest.stuck },
        ...(calls ? { meterSeen: calls.seen, meterMonth: calls.month } : {}),
      },
      deps.db,
    );
  } catch (err) {
    warn("keeping the heartbeat's week", err);
    return none;
  }
  // Each week the brand claimed, counted once: reported or late, against brands listed.
  for (const week of weeks) buffer.add(week, `${FLEET_ROWS.orgs}/visited`, 1);

  // 3. The organisation's mark, one transaction a week.
  let late = 0;
  for (const report of reports) {
    const credit = await runLaneTransaction(async (txn) => {
      const mark = await readLaneMarkTx(txn, markId, deps.controlDb);
      const c = creditMark(mark, report, deps.now.toISOString());
      if (!c.late) writeLaneMarkTx(txn, markId, c.mark, deps.controlDb);
      return c;
    }, deps.controlDb).catch((err: unknown) => {
      warn("moving the organisation's mark", err);
      return null;
    });
    if (!credit) continue;
    if (credit.late) {
      late += 1;
      buffer.add(report.week, `${FLEET_ROWS.orgs}/late`, 1);
      continue;
    }
    for (const k of credit.orgCells) buffer.add(report.week, k, 1);
    for (const [k, n] of Object.entries(credit.things)) buffer.add(report.week, k, n);
    for (const [k, n] of Object.entries(report.plain)) buffer.add(report.week, k, n);
  }
  return { weeks: reports.length, late };
}
