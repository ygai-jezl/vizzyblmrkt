import {
  allocateWorkRefs,
  appendWorkLog,
  changeWorkTask,
  countWorkLog,
  countWorkTasks,
  createSuggestedWorkTask,
  createWorkTask,
  deleteWorkTask,
  findWorkTask,
  findWorkTaskByRef,
  listTaskDecisions,
  listTaskLog,
  listWorkChecks,
  listWorkTasks,
  newWorkImportId,
  newWorkTaskId,
  claimImportRefs,
  peekImportRefs,
  peekWorkRefs,
  releaseImportRefs,
  saveDraftedWorkLog,
  TenantValidationError,
  type NewWorkTask,
  type SuggestionAccept,
  type WorkChangePlan,
  type WorkTaskPatch,
  type WorkWrite,
} from "@/lib/tenant";
import { teamMemberNames } from "@/lib/team/names";
import { isUsageMeterEnabled } from "@/lib/plans/flags";
import { countsFor } from "@/lib/loops/count";
import { isLoopsEnabled } from "@/lib/loops/flags";
import type { Region } from "@/lib/types/tenant";
import { countForCheck, type EventLabel } from "./counted";
import { importFileName, matchColumns, parseSheet, readSheet, type ImportRow } from "./import";
import type { AddTaskBody, CheckActionBody, CheckInput, DecisionBody, EditTaskBody, ImportBody, WorkFilters } from "./inputs";
import { draftRefusal, ok, refuse, type DraftedSave, type WorkRefused, type WorkResult } from "./result";
import { checkAfterRead, checkForDonePart, checkOnDone, dayIn, lookAgain, morningOf, partOf } from "./schedule";
import { brandForTask, brandIn, mapLimit, nowOf, regionName, seesTask, zoneForTask, type WorkBrand, type WorkDeps, type WorkScope } from "./scope";
import { stageById } from "./stages";
import {
  agreedOf,
  DECISION_OPTION_IDS,
  isClosedStatus,
  isPlanApprovalQuestion,
  MAX_WORK_REF,
  onOpenList,
  PLAN_APPROVAL_OPTIONS,
  PLAN_APPROVAL_QUESTION,
  SET_BY_MEASURE,
  WORK_LIMITS,
  type Measure,
  type ProposedKind,
  type TypedLink,
  type WorkCheck,
  type WorkCheckRow,
  type WorkDecision,
  type WorkLogRowOf,
  type WorkOrigin,
  type WorkStatus,
  type WorkTask,
  withoutLoopLines,
} from "./types";
import { checkMeasure, checkMeasureBrand, checkTypedLinks, ideaExists, placeForChange, placeForNew, stableJson, tasksByRef } from "./validate";
import {
  askAgainNotice,
  countedLine,
  doneCheckNotice,
  IMPORT_ROW_MESSAGES,
  nextCheckNotice,
  OPERATOR_COUNT_LINE,
  refHintText,
  thenCheckNotice,
  unknownStatusesText,
  WORK_STATUS_LABEL,
  type ImportRowProblem,
  type PlanState,
} from "./words";

/**
 * Work's service (ADR-0020): what the admin routes do, each returning a result the route turns
 * into a response. Who the person is comes from src/lib/work/scope.ts (read live, never from the
 * request); data only through src/lib/tenant/work.ts.
 *
 * The rules here are the two choices Work makes for a team, each with its line in
 * src/lib/loops/registry.ts:
 * - work_check_due: a check shows once it is due. A person sets the date, the task to wait for or
 *   the measure; the rule only decides that the time has come.
 * - work_ready: which To do tasks are ready to start, and in what order Review shows them. People
 *   pick which to start; the pick is a change row, so a later learner can read it.
 *
 * Origin, the proposed kind of win, `recommended` on a decision and every check's setBy are set
 * here, by the path that made them. Text people write is data, never instructions.
 */

/** What the rules know about another task: its status, "gone" when it no longer exists, or undefined when it couldn't be read. */
export type TaskLookup = (taskId: string) => WorkStatus | "gone" | undefined;

const finished = (s: WorkStatus | "gone" | undefined): boolean => s === "gone" || (s !== undefined && isClosedStatus(s));

/**
 * A task's check is due (work_check_due): a date check once its time has come; an after_task
 * check once the task it waits for is Done, Dropped or gone. A task that couldn't be read keeps
 * the check waiting, so a region that didn't answer never makes one due.
 */
export function isCheckDue(task: Pick<WorkTask, "check">, now: Date, lookup: TaskLookup = () => undefined): boolean {
  const c = task.check;
  if (!c) return false;
  if (c.kind === "date") return c.at !== null && Date.parse(c.at) <= now.getTime();
  return c.taskId !== null && finished(lookup(c.taskId));
}

/**
 * A task is ready to start (work_ready): To do, every task blocking it Done, Dropped or gone,
 * waiting on nothing, and no check still to come (a check not due yet parks the task until then).
 */
export function isReadyToStart(task: Pick<WorkTask, "status" | "blockedBy" | "waitingOn" | "check">, now: Date, lookup: TaskLookup = () => undefined): boolean {
  if (task.status !== "todo" || task.waitingOn) return false;
  if (!task.blockedBy.every((id) => finished(lookup(id)))) return false;
  return !task.check || isCheckDue(task, now, lookup);
}

/** The order Review shows ready tasks in: Must have first, then the earlier stage (none last), then the lower ref. */
export function readyOrder(a: Pick<WorkTask, "mustHave" | "stage" | "ref">, b: Pick<WorkTask, "mustHave" | "stage" | "ref">): number {
  if (a.mustHave !== b.mustHave) return a.mustHave ? -1 : 1;
  const sa = a.stage ? stageById(a.stage)!.n : 99;
  const sb = b.stage ? stageById(b.stage)!.n : 99;
  return sa - sb || a.ref - b.ref;
}

/** The list's order: checks due first, then Must have, then the most recently changed. */
export function listOrder(a: { due: boolean; task: Pick<WorkTask, "mustHave" | "updatedAt" | "ref"> }, b: { due: boolean; task: Pick<WorkTask, "mustHave" | "updatedAt" | "ref"> }): number {
  if (a.due !== b.due) return a.due ? -1 : 1;
  if (a.task.mustHave !== b.task.mustHave) return a.task.mustHave ? -1 : 1;
  return b.task.updatedAt.localeCompare(a.task.updatedAt) || b.task.ref - a.task.ref;
}

/** Decisions oldest first: by time, and a row that replaces another always after it. */
export function decisionOrder(a: WorkLogRowOf<"decision">, b: WorkLogRowOf<"decision">): number {
  return a.at.localeCompare(b.at) || (b.decision.replaces === a.id ? -1 : a.decision.replaces === b.id ? 1 : a.id.localeCompare(b.id));
}

/**
 * Each plan link's approval: the newest decision row for the same url and version. A change to
 * the link's url or version leaves the old rows in place, so it reads Not approved yet.
 */
export function planStates(links: readonly TypedLink[], decisions: ReadonlyArray<WorkLogRowOf<"decision">>): Array<{ url: string; version: string | null; title: string; state: PlanState; decisionId: string | null }> {
  return links
    .filter((l): l is Extract<TypedLink, { kind: "plan" }> => l.kind === "plan")
    .map((l) => {
      const rows = decisions
        .filter((d) => d.decision.plan && d.decision.plan.url === l.url && (d.decision.plan.version ?? null) === (l.version ?? null) && d.decision.chosen)
        .sort(decisionOrder);
      const newest = rows[rows.length - 1];
      const option = newest?.decision.chosen?.option;
      const state: PlanState = option === "a" ? "approved" : option === "b" ? "change_it" : option === "c" ? "not_now" : "not_approved_yet";
      return { url: l.url, version: l.version ?? null, title: l.title, state, decisionId: newest?.id ?? null };
    });
}

// --- Reading tasks -----------------------------------------------------------------------------

/** How many closed tasks the list reads beside the open ones, unless it shows closed tasks. */
const RECENT_CLOSED = 500;
/** Tasks it looks up one by one for blockers and checks the tasks read didn't hold; past this many it reads them all at once. */
const LOOKUPS = 30;

export interface RegionDown {
  region: Region;
  name: string;
}

const downOf = (regions: Iterable<Region>): RegionDown[] => [...new Set(regions)].map((r) => ({ region: r, name: regionName(r) }));

/** The brand the list reads for: the session brand in the brand view; any, one, or whole business ("none") in the organisation view. */
function brandFilterOf(scope: WorkScope, brand: string | null): { ok: true; brandId: string | null | undefined } | WorkRefused {
  if (scope.view === "brand") return { ok: true, brandId: scope.session.id };
  if (brand === null) return { ok: true, brandId: undefined };
  if (brand === "none") return { ok: true, brandId: null };
  return brandIn(scope, brand) ? { ok: true, brandId: brand } : refuse("brand_unknown");
}

interface Loaded {
  tasks: WorkTask[];
  unanswered: Region[];
  unreadable: number;
  /** Regions holding more tasks than one read takes (5,000): some of theirs aren't here. */
  full: Region[];
}

/**
 * The person's tasks: the open ones, and the newest closed ones (or every closed one), for one
 * brand or all, with tasks that have a check, so a Done task with a check due is in. In the
 * organisation view across brands this reads (organisationId, open, closedAt desc); for one
 * brand it reads by equality alone and the caller sorts.
 */
export async function loadTasks(scope: WorkScope, opts: { brandId: string | null | undefined; allClosed: boolean }, deps: WorkDeps): Promise<Loaded> {
  const brandOpt = opts.brandId === undefined ? {} : { brandId: opts.brandId };
  const [open, closed, checks] = await Promise.all([
    listWorkTasks(scope.organisationId, { open: true, ...brandOpt }, deps),
    listWorkTasks(scope.organisationId, { open: false, ...brandOpt, limit: opts.allClosed ? WORK_LIMITS.tasks : RECENT_CLOSED }, deps),
    listWorkChecks(scope.organisationId, brandOpt, deps),
  ]);
  const byId = new Map<string, WorkTask>();
  for (const t of [...open.rows, ...closed.rows, ...checks.rows]) if (seesTask(scope, t)) byId.set(t.id, t);
  // Only the newest closed tasks are read unless all are asked for, so a full closed read says nothing then.
  const full = [...open.full, ...checks.full, ...(opts.allClosed ? closed.full : [])];
  return {
    tasks: [...byId.values()],
    unanswered: [...new Set([...open.unanswered, ...closed.unanswered, ...checks.unanswered])],
    unreadable: open.unreadable + closed.unreadable + checks.unreadable,
    full: [...new Set(full)],
  };
}

/**
 * Tasks by id: null when gone, absent when unread. First those read; with more than LOOKUPS still
 * wanted, the organisation's tasks of every brand read at once as the list reads them (the open
 * ones and the newest 500 closed in each region), then every closed one (up to 5,000 in each
 * region) if still more than LOOKUPS are wanted; then one by one, up to LOOKUPS. A region that
 * didn't answer goes in `down`, so the caller says so; any id still unread is warned about, and
 * its rules wait.
 */
async function lookupMap(scope: WorkScope, known: readonly WorkTask[], wanted: Iterable<string>, deps: WorkDeps, down?: Set<Region>): Promise<Map<string, WorkTask | null>> {
  const map = new Map<string, WorkTask | null>(known.map((t) => [t.id, t]));
  let missing = [...new Set(wanted)].filter((id) => !map.has(id));
  for (const closedLimit of [RECENT_CLOSED, WORK_LIMITS.tasks]) {
    if (missing.length <= LOOKUPS) break;
    const reads = await Promise.all([
      ...(closedLimit === RECENT_CLOSED ? [listWorkTasks(scope.organisationId, { open: true }, deps)] : []),
      listWorkTasks(scope.organisationId, { open: false, limit: closedLimit }, deps),
    ]);
    for (const read of reads) {
      for (const t of read.rows) if (!map.has(t.id)) map.set(t.id, t);
      for (const r of read.unanswered) down?.add(r);
    }
    missing = missing.filter((id) => !map.has(id));
  }
  const unread = missing.length - LOOKUPS;
  if (unread > 0) console.warn(`[work] ${unread} tasks that checks or blockers name weren't read: those wait`);
  await mapLimit(missing.slice(0, LOOKUPS), 5, async (id) => {
    try {
      const r = await findWorkTask(scope.organisationId, id, deps);
      for (const region of r.unanswered) down?.add(region);
      if (r.task) map.set(id, r.task);
      else if (!r.unanswered.length) map.set(id, null);
    } catch {
      // Unread: the rules wait.
    }
  });
  return map;
}

const lookupOf =
  (map: ReadonlyMap<string, WorkTask | null>): TaskLookup =>
  (id) => {
    if (!map.has(id)) return undefined;
    const t = map.get(id);
    return t ? t.status : "gone";
  };

/** Another task as a task shows it: its ref, title and status when the person sees it. */
export type TaskMention = { id: string; ref: number; title: string; status: WorkStatus } | { id: string; hidden: true } | { id: string; gone: true } | { id: string; unread: true };

function mention(scope: WorkScope, map: ReadonlyMap<string, WorkTask | null>, id: string): TaskMention {
  if (!map.has(id)) return { id, unread: true };
  const t = map.get(id);
  if (!t) return { id, gone: true };
  if (!seesTask(scope, t)) return { id, hidden: true };
  return { id, ref: t.ref, title: t.title, status: t.status };
}

/** A task as the list and the task page show it. */
export interface WorkTaskView {
  task: WorkTask;
  brandName: string | null;
  due: boolean;
  /** Every task it waits for; `waiting` when one of them is still open. */
  blockers: TaskMention[];
  waiting: boolean;
  /** The task an after_task check waits for. */
  checkTask: TaskMention | null;
  fromVizzy: boolean;
}

/** The measure a task's check asks about, when a measure set the check. */
function checkPartOf(task: Pick<WorkTask, "measure" | "check">): ReturnType<typeof partOf> {
  return partOf(task.measure, task.check?.setBy === SET_BY_MEASURE ? (task.check.which ?? null) : null);
}

/**
 * A Used part that names this copy's own AI purpose, type or LOOPS kind. What Work counts for it
 * is for the people LOOPS_OPERATOR_EMAILS names (decision 14): nobody else, Vizzy included, is
 * counted for, gets the count, or reads its line.
 */
export function isOperatorCount(part: ReturnType<typeof partOf>): boolean {
  return part !== null && part.kind === "used" && ("purpose" in part.counts || "type" in part.counts || "loopKind" in part.counts);
}

/**
 * The task as this person gets it: a loop line link and a count of this copy's own purposes only
 * for operators (decision 14). An edit by anyone else keeps the loop lines (checkTypedLinks).
 */
export function taskForViewer(scope: WorkScope, task: WorkTask): WorkTask {
  if (scope.operator) return task;
  let out = task;
  if (task.typedLinks.some((l) => l.kind === "loop_line")) out = { ...out, typedLinks: withoutLoopLines(task.typedLinks) };
  if (task.check?.counted && isOperatorCount(checkPartOf(task))) out = { ...out, check: { ...task.check, counted: null } };
  return out;
}

function viewOf(scope: WorkScope, task: WorkTask, map: ReadonlyMap<string, WorkTask | null>, now: Date): WorkTaskView {
  const lookup = lookupOf(map);
  const blockers = task.blockedBy.map((id) => mention(scope, map, id));
  return {
    task: taskForViewer(scope, task),
    brandName: brandIn(scope, task.brandId)?.name ?? null,
    due: isCheckDue(task, now, lookup),
    blockers,
    waiting: task.blockedBy.some((id) => {
      const s = lookup(id);
      return s !== undefined && !finished(s);
    }),
    checkTask: task.check?.taskId ? mention(scope, map, task.check.taskId) : null,
    fromVizzy: task.origin.kind === "suggestion",
  };
}

const wantedOf = (tasks: readonly WorkTask[]) => tasks.flatMap((t) => [...t.blockedBy, ...(t.check?.taskId ? [t.check.taskId] : [])]);

export interface WorkList {
  view: WorkScope["view"];
  owner: boolean;
  brands: Array<{ id: string; name: string; region: Region }>;
  filters: WorkFilters;
  tasks: WorkTaskView[];
  counts: { open: number; mustHave: number; due: number };
  /** The regions whose tasks couldn't be read: their tasks are hidden, and the list says so. */
  regionsDown: RegionDown[];
  /** The regions holding more tasks than one read takes: some are missing, and the list says so. */
  regionsFull: RegionDown[];
  unreadable: number;
}

function statusMatches(f: WorkFilters["status"], t: WorkTask, now: Date): boolean {
  if (f === "all") return true;
  if (f === "open") return onOpenList(t, now);
  if (f === "closed") return !onOpenList(t, now);
  return t.status === f;
}

/** The one list, filtered, in its order. */
export async function listTasks(scope: WorkScope, filters: WorkFilters, deps: WorkDeps = {}): Promise<WorkResult<WorkList>> {
  const brand = brandFilterOf(scope, filters.brand);
  if ("error" in brand) return brand;
  const now = nowOf(deps);
  const loaded = await loadTasks(scope, { brandId: brand.brandId, allClosed: filters.status !== "open" }, deps);
  const down = new Set(loaded.unanswered);
  const map = await lookupMap(scope, loaded.tasks, wantedOf(loaded.tasks), deps, down);
  const views = loaded.tasks.map((t) => viewOf(scope, t, map, now));
  const shown = views.filter(
    (v) =>
      (statusMatches(filters.status, v.task, now) || (filters.due && v.due)) &&
      (!filters.stage || (filters.stage === "none" ? v.task.stage === null : v.task.stage === filters.stage)) &&
      (!filters.mustHave || v.task.mustHave) &&
      (!filters.due || v.due) &&
      (!filters.kind || (filters.kind === "none" ? v.task.measure === null : v.task.measure?.kind === filters.kind)),
  );
  shown.sort(listOrder);
  return ok({
    view: scope.view,
    owner: scope.owner,
    brands: scope.brands.map((b) => ({ id: b.id, name: b.name, region: b.region })),
    filters,
    tasks: shown,
    counts: { open: views.filter((v) => onOpenList(v.task, now)).length, mustHave: views.filter((v) => onOpenList(v.task, now) && v.task.mustHave).length, due: views.filter((v) => v.due).length },
    regionsDown: downOf(down),
    regionsFull: downOf(loaded.full),
    unreadable: loaded.unreadable,
  });
}

/** The checks due now that the person sees, in the list's order: for Review and Today. */
export async function dueChecks(scope: WorkScope, deps: WorkDeps = {}): Promise<{ tasks: WorkTaskView[]; regionsDown: RegionDown[] }> {
  const now = nowOf(deps);
  const brandOpt = scope.view === "brand" ? { brandId: scope.session.id } : {};
  const checks = await listWorkChecks(scope.organisationId, brandOpt, deps);
  // Each task once, by id, as loadTasks keeps them.
  const mine = [...new Map(checks.rows.filter((t) => seesTask(scope, t)).map((t) => [t.id, t])).values()];
  // Every task an after_task check waits for, however many: one not read never shows as due.
  const down = new Set(checks.unanswered);
  const map = await lookupMap(
    scope,
    mine,
    mine.flatMap((t) => (t.check?.taskId ? [t.check.taskId] : [])),
    deps,
    down,
  );
  const views = mine.map((t) => viewOf(scope, t, map, now)).filter((v) => v.due);
  views.sort(listOrder);
  return { tasks: views, regionsDown: downOf(down) };
}

/** The To do tasks ready to start that the person sees (work_ready), in Review's order: Must have, then stage, then ref. */
export async function readyTasks(scope: WorkScope, deps: WorkDeps = {}): Promise<{ tasks: WorkTaskView[]; regionsDown: RegionDown[] }> {
  const now = nowOf(deps);
  const loaded = await loadTasks(scope, { brandId: scope.view === "brand" ? scope.session.id : undefined, allClosed: false }, deps);
  const todo = loaded.tasks.filter((t) => t.status === "todo");
  // Blockers the brand view didn't read (whole business tasks, another brand's) are looked up, however many.
  const down = new Set(loaded.unanswered);
  const map = await lookupMap(scope, loaded.tasks, wantedOf(todo), deps, down);
  const lookup = lookupOf(map);
  const ready = todo.filter((t) => isReadyToStart(t, now, lookup)).sort(readyOrder);
  return { tasks: ready.map((t) => viewOf(scope, t, map, now)), regionsDown: downOf(down) };
}

// --- One task ----------------------------------------------------------------------------------

/** The task with this ref, if the person sees it. */
async function taskByRef(scope: WorkScope, ref: number, deps: WorkDeps): Promise<WorkTask | null> {
  const { task } = await findWorkTaskByRef(scope.organisationId, ref, deps);
  return task && seesTask(scope, task) ? task : null;
}

const writeOf = (scope: WorkScope, now: Date, tool: string = "work_page"): WorkWrite => ({
  source: { who: { kind: "person", id: scope.userId }, tool, session: null },
  at: now.toISOString(),
  day: dayIn(now, scope.session.timeZone),
});

/** The line on a measure's check: what Work counted, or what it can't count. Null on any other check. `eventLabel` names an event as its catalog does. */
export function checkLineOf(scope: WorkScope, task: WorkTask, eventLabel?: EventLabel): string | null {
  const part = checkPartOf(task);
  if (!part || !task.check) return null;
  if (!scope.operator && isOperatorCount(part)) return OPERATOR_COUNT_LINE;
  const brand = brandForTask(scope, task);
  const meterOff = part.kind === "used" && "purpose" in part.counts && !isUsageMeterEnabled();
  const label = part.kind === "used" && "productEvent" in part.counts ? eventLabel?.(part.counts.productEvent.connectionId, part.counts.productEvent.event) : undefined;
  // An image kind counts nothing while image style versions are off (decision 22).
  const imagesOff = part.kind === "used" && "loopKind" in part.counts && !countsFor(part.counts.loopKind);
  return countedLine({ part, counted: task.check.counted ?? null, brandName: brand?.name ?? null, timeZone: zoneForTask(scope, task), meterOff, loopsOn: isLoopsEnabled(), imagesOff, eventLabel: label ?? null });
}

/**
 * Count a due measure's check once, and keep the count on it (a change row by the system, tool
 * work_count). A check counted already, not due, or with nothing Work can count is left alone, and
 * so is one that counts this copy's own purposes when the person isn't an operator.
 */
export async function countDueCheck(scope: WorkScope, task: WorkTask, deps: WorkDeps): Promise<WorkTask> {
  const now = nowOf(deps);
  const check = task.check;
  if (!check || check.setBy !== SET_BY_MEASURE || check.counted || !isCheckDue(task, now)) return task;
  if (!scope.operator && isOperatorCount(checkPartOf(task))) return task;
  let counted;
  try {
    counted = await countForCheck(task, brandForTask(scope, task), deps, now);
  } catch (err) {
    console.warn("[work] counting a check failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown");
    return task;
  }
  if (!counted) return task;
  const r = await changeWorkTask(
    scope.organisationId,
    task.id,
    task.region,
    (cur) => (cur.check && cur.check.setAt === check.setAt && !cur.check.counted ? { patch: { check: { ...cur.check, counted } } } : null),
    { source: { who: { kind: "system", id: null }, tool: "work_count", session: null }, at: now.toISOString(), day: dayIn(now, zoneForTask(scope, task)) },
    deps,
  );
  return r.ok ? r.task : "task" in r ? r.task : task;
}

/** The most due measure checks one read of the Log or of get_work counts. */
export const COUNT_ON_READ = 10;

/**
 * Count the due measure checks among these tasks once, when they first show (up to 10 a read),
 * as the task page does: each task as counted, or as it was when its count fails.
 */
export async function countShownChecks(scope: WorkScope, tasks: readonly WorkTask[], deps: WorkDeps): Promise<WorkTask[]> {
  let n = 0;
  return mapLimit(tasks, 4, async (t) => {
    if (t.check?.setBy !== SET_BY_MEASURE || t.check.counted || n >= COUNT_ON_READ) return t;
    n += 1;
    try {
      return await countDueCheck(scope, t, deps);
    } catch {
      return t;
    }
  });
}

export interface WorkTaskPage extends WorkTaskView {
  decisions: Array<WorkLogRowOf<"decision">>;
  plans: ReturnType<typeof planStates>;
  /** On a measure's check: what Work counted, or what it can't count. */
  checkLine: string | null;
  timeZone: string;
  /** `{ userId: name }` for the people the task names who are on a team the person sees. */
  names: Record<string, string>;
  can: { delete: boolean; prAndSwitch: boolean; loopLine: boolean };
  regionsDown: RegionDown[];
}

/** One task, with its decisions, its plan links' approvals and the count on a due measure's check. */
export async function taskPage(scope: WorkScope, ref: number, deps: WorkDeps = {}): Promise<WorkResult<WorkTaskPage>> {
  const found = await findWorkTaskByRef(scope.organisationId, ref, deps);
  if (!found.task || !seesTask(scope, found.task)) return refuse("not_found");
  const task = await countDueCheck(scope, found.task, deps);
  const [stored, map] = await Promise.all([listTaskDecisions(scope.organisationId, task.region, task.id, deps), lookupMap(scope, [task], wantedOf([task]), deps)]);
  const decisions = [...stored].sort(decisionOrder);
  const ids = [
    task.origin.kind === "coding_agent" ? null : task.origin.by,
    task.check?.setBy,
    task.measure?.setBy,
    ...task.recent.map((r) => r.who.id),
    ...decisions.map((d) => d.decision.chosen?.by),
  ];
  const names: Record<string, string> = {};
  for (const b of scope.brands.slice(0, 5)) {
    Object.assign(names, await teamMemberNames({ tenantId: b.id, region: b.region, source: "system" }, ids, { db: deps.controlDb, lookup: deps.lookup }));
  }
  const brand = brandForTask(scope, task);
  const repos = brand ? brand.repos : scope.brands.flatMap((b) => b.repos);
  return ok({
    ...viewOf(scope, task, map, nowOf(deps)),
    decisions,
    plans: planStates(task.typedLinks, decisions),
    checkLine: checkLineOf(scope, task),
    timeZone: zoneForTask(scope, task),
    names,
    can: { delete: scope.canDelete, prAndSwitch: repos.length > 0, loopLine: scope.operator },
    regionsDown: downOf(found.unanswered),
  });
}

// --- Adding and changing -----------------------------------------------------------------------

/** Take `n` refs from the organisation's counter: the first, or null when there aren't that many left. */
async function takeRefs(scope: WorkScope, n: number, deps: WorkDeps, now: Date): Promise<number | null> {
  try {
    return await allocateWorkRefs(scope.organisationId, n, deps.controlDb, now);
  } catch (err) {
    if (err instanceof TenantValidationError && err.message.includes("no_refs_left")) return null;
    throw err;
  }
}

class Changed extends Error {}

/** A check a person sets, in the task's time zone, or why not. */
async function personCheck(scope: WorkScope, input: CheckInput, self: string | null, timeZone: string, deps: WorkDeps, now: Date): Promise<{ ok: true; check: WorkCheck } | WorkRefused> {
  const base = { note: input.note ?? "", setBy: scope.userId, setAt: now.toISOString(), which: null, counted: null };
  if (input.kind === "date") return { ok: true, check: { kind: "date", at: morningOf(input.day, timeZone, input.time), taskId: null, ...base } };
  const found = await tasksByRef(scope, [input.ref], self, deps, "check_task_missing");
  if (!found.ok) return found;
  return { ok: true, check: { kind: "after_task", at: null, taskId: found.tasks[0]!.id, ...base } };
}

/** The fields an edit or an add sets, checked against what is kept, before the write. */
interface Checked {
  patch: WorkTaskPatch;
  /** Set only when the request set a check (or cleared one). */
  check?: WorkCheck | null;
}

/**
 * Check an add's or an edit's fields against the task as it is (null for a new task): brand,
 * blockers, idea, clipping, typed links, measure and check. Async lookups happen here, before the
 * write.
 */
async function checkFields(
  scope: WorkScope,
  body: AddTaskBody | EditTaskBody,
  current: WorkTask | null,
  place: { brandId: string | null; region: Region; addedFrom: string },
  deps: WorkDeps,
  now: Date,
  extra: { proposed?: ProposedKind | null } = {},
): Promise<{ ok: true; value: Checked } | WorkRefused> {
  const patch: WorkTaskPatch = {};
  for (const k of ["title", "description", "notes", "status", "stage", "mustHave", "links", "waitingOn"] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (!current || body.brandId !== undefined) patch.brandId = place.brandId;
  if (body.blockedBy !== undefined) {
    const found = await tasksByRef(scope, body.blockedBy, current?.id ?? null, deps);
    if (!found.ok) return found;
    patch.blockedBy = found.tasks.map((t) => t.id);
  }
  if ("idea" in body && body.idea !== undefined) {
    if (body.idea === null) Object.assign(patch, { ideaId: null, ideaBrandId: null });
    else {
      if (!(await ideaExists(scope, body.idea.brandId, body.idea.ideaId, deps))) return refuse("idea_missing");
      Object.assign(patch, { ideaId: body.idea.ideaId, ideaBrandId: body.idea.brandId });
    }
  }
  if (body.clipping !== undefined) {
    if (body.clipping && !brandIn(scope, body.clipping.brandId)) return refuse("brand_unknown");
    patch.clipping = body.clipping;
  }
  const after = { ...(current ?? {}), ...patch } as Partial<WorkTask>;
  const brand = brandForTask(scope, { brandId: after.brandId ?? null });
  // A new brand checks again what named the old one's: pull requests and switches from its repos,
  // and a product event counted from its product.
  const moved = current !== null && body.brandId !== undefined && brandForTask(scope, current)?.id !== brand?.id;
  const keptLinks = moved ? current.typedLinks.filter((l) => l.kind !== "pull_request" && l.kind !== "switch") : (current?.typedLinks ?? []);
  if (body.typedLinks !== undefined) {
    const links = await checkTypedLinks(scope, body.typedLinks, { brand, current: keptLinks }, deps);
    if (!links.ok) return links;
    patch.typedLinks = links.links;
  } else if (moved && keptLinks.length !== current.typedLinks.length) {
    const links = await checkTypedLinks(scope, current.typedLinks, { brand, current: keptLinks }, deps);
    if (!links.ok) return links;
  }
  if (moved && body.measure === undefined) {
    const problem = await checkMeasureBrand(scope, current.measure, brand, deps);
    if (problem) return problem;
  }
  if (body.measure !== undefined) {
    const m = await checkMeasure(
      scope,
      body.measure,
      {
        title: after.title ?? "",
        description: after.description ?? "",
        stage: after.stage ?? null,
        brandId: after.brandId ?? null,
        ideaId: after.ideaId ?? null,
        typedLinks: patch.typedLinks ?? current?.typedLinks ?? [],
        brand,
        current: current?.measure ?? null,
        ...(extra.proposed !== undefined ? { proposed: extra.proposed } : {}),
      },
      deps,
      now,
    );
    if (!m.ok) return m;
    patch.measure = m.measure;
  }
  const out: Checked = { patch };
  if (body.check !== undefined) {
    if (current?.check?.setBy === SET_BY_MEASURE) return refuse("measure_check_kept");
    if (body.check === null) out.check = null;
    else {
      const zone = (brandIn(scope, place.brandId) ?? brandIn(scope, place.addedFrom) ?? scope.session).timeZone;
      const c = await personCheck(scope, body.check, current?.id ?? null, zone, deps, now);
      if (!c.ok) return c;
      out.check = c.check;
    }
  }
  return { ok: true, value: out };
}

/** The measure parts read Better, Same or Worse since the task last went Done. */
export interface PartsRead {
  first: boolean;
  then: boolean;
}

/**
 * What the change does to status, closedAt and the check, on the freshest task: closing sets
 * closedAt, reopening clears it; Done on a measure that looks after N days sets the measure's
 * check (replacing any open check, and saying so); reopening, Dropped, or a measure that no
 * longer has the part a measure's check asks about clears that check. On a task Done already, a
 * measure set or changed asks as Done would have: a check still to come moves to its part's new
 * days, and with none, the first part not read yet that looks by days gets its check, from
 * closedAt (now when that has passed). A part already read is never asked again (`read`).
 */
export function settle(
  current: WorkTask | null,
  patch: WorkTaskPatch,
  check: WorkCheck | null | undefined,
  timeZone: string,
  now: Date,
  read: PartsRead = { first: false, then: false },
): { patch: WorkTaskPatch; replaced: boolean; setByDone: WorkCheck | null } {
  const out: WorkTaskPatch = { ...patch };
  if (check !== undefined) out.check = check;
  const before = current?.status ?? null;
  const status = out.status ?? before ?? "todo";
  const measure: Measure | null = out.measure !== undefined ? out.measure : (current?.measure ?? null);
  let liveCheck: WorkCheck | null = out.check !== undefined ? out.check : (current?.check ?? null);
  let replaced = false;
  let setByDone: WorkCheck | null = null;
  if (status !== before) {
    out.closedAt = isClosedStatus(status) ? now.toISOString() : null;
    if (status === "done") {
      const c = checkOnDone(measure, out.closedAt!, timeZone, now);
      if (c) {
        replaced = liveCheck !== null;
        liveCheck = c;
        setByDone = c;
      }
    } else if (liveCheck?.setBy === SET_BY_MEASURE) {
      liveCheck = null;
    }
  }
  const measureChanged = out.measure !== undefined && current !== null && stableJson(out.measure) !== stableJson(current.measure);
  if (liveCheck?.setBy === SET_BY_MEASURE && !partOf(measure, liveCheck.which)) liveCheck = null;
  else if (liveCheck?.setBy === SET_BY_MEASURE && measureChanged && liveCheck.counted) liveCheck = { ...liveCheck, counted: null };
  if (status === "done" && before === "done" && measureChanged && current?.closedAt) {
    const pending = liveCheck?.setBy === SET_BY_MEASURE ? liveCheck : null;
    if (pending?.which) {
      const was = partOf(current.measure, pending.which);
      const part = partOf(measure, pending.which);
      const days = (p: typeof part) => (p && "days" in p.look ? p.look.days : null);
      if (part && days(part) !== null && days(part) !== days(was)) {
        const moved = checkForDonePart(pending.which, part, current.closedAt, timeZone, now);
        if (moved) liveCheck = setByDone = moved;
      }
    } else if (!pending) {
      const which = !read.first ? "first" : !read.then ? "then" : null;
      const c = which ? checkForDonePart(which, partOf(measure, which), current.closedAt, timeZone, now) : null;
      if (c) {
        replaced = liveCheck !== null;
        liveCheck = setByDone = c;
      }
    }
  }
  const was = current?.check ?? null;
  if (liveCheck !== was || out.check !== undefined) out.check = liveCheck;
  return { patch: out, replaced, setByDone };
}

export interface ChangeDone {
  task: WorkTaskView;
  /** What Work did besides what was asked, such as the check Done set. */
  notice: string | null;
}

/** Add a task from the add page or quick add: the person's own. */
export async function addTask(scope: WorkScope, body: AddTaskBody, deps: WorkDeps = {}): Promise<WorkResult<ChangeDone>> {
  return addTaskWith(scope, body, { kind: "person", by: scope.userId }, deps);
}

/** What a Review accept adds to addTaskWith: Vizzy's proposed kind, and the suggestion's move written with the task. */
export interface AddFromSuggestion {
  /** The kind Vizzy proposed; left out when it proposed none, so the rule proposes as for any add. */
  proposed?: ProposedKind | null;
  accept: SuggestionAccept;
}

/**
 * Add a task with the origin its path sets (the add page, an import, a Review accept), never one
 * read from a request. The ref comes from the organisation's counter first, so a write that then
 * fails leaves a gap. From a suggestion, the task and the suggestion's move to acted commit
 * together, in the session brand's region (src/lib/work/suggestions.ts).
 */
export async function addTaskWith(
  scope: WorkScope,
  body: AddTaskBody,
  origin: WorkOrigin,
  deps: WorkDeps = {},
  opts: { id?: string; tool?: string; suggestion?: AddFromSuggestion } = {},
): Promise<WorkResult<ChangeDone>> {
  const now = nowOf(deps);
  const place = placeForNew(scope, body.brandId);
  if ("error" in place) return place;
  if (opts.suggestion && place.region !== scope.session.region) return refuse("suggestion_other_region");
  const { count } = await countWorkTasks(scope.organisationId, deps);
  if (count >= WORK_LIMITS.tasks) return refuse("tasks_full");
  const checked = await checkFields(scope, body, null, { ...place, addedFrom: scope.session.id }, deps, now, opts.suggestion?.proposed !== undefined ? { proposed: opts.suggestion.proposed } : {});
  if (!checked.ok) return checked;
  const zone = (brandIn(scope, place.brandId) ?? scope.session).timeZone;
  const settled = settle(null, { status: body.status ?? "todo", ...checked.value.patch }, checked.value.check, zone, now);
  const ref = await takeRefs(scope, 1, deps, now);
  if (ref === null) return refuse("refs_full");
  const p = settled.patch;
  const task: NewWorkTask = {
    id: opts.id ?? newWorkTaskId(),
    organisationId: scope.organisationId,
    brandId: place.brandId,
    addedFrom: scope.session.id,
    region: place.region,
    ref,
    title: p.title ?? body.title,
    description: p.description ?? "",
    notes: p.notes ?? "",
    status: p.status ?? "todo",
    stage: p.stage ?? null,
    mustHave: p.mustHave ?? false,
    links: p.links ?? [],
    blockedBy: p.blockedBy ?? [],
    waitingOn: p.waitingOn ?? null,
    ideaId: p.ideaId ?? null,
    ideaBrandId: p.ideaBrandId ?? null,
    clipping: p.clipping ?? null,
    typedLinks: p.typedLinks ?? [],
    measure: p.measure ?? null,
    origin,
    check: p.check ?? null,
    closedAt: p.closedAt ?? null,
  };
  const write = writeOf(scope, now, opts.tool ?? body.via ?? "work_page");
  let made: { task: WorkTask };
  if (opts.suggestion) {
    const r = await createSuggestedWorkTask(scope.ctx, task, write, opts.suggestion.accept, deps);
    if (!r.ok) {
      if (r.error === "other_region") return refuse("suggestion_other_region");
      if (r.error === "changed") return refuse("suggestion_changed");
      if (r.error === "not_found") return refuse("suggestion_missing");
      return refuse("suggestion_decided");
    }
    made = r;
  } else {
    made = await createWorkTask(task, write, deps);
  }
  const map = await lookupMap(scope, [made.task], wantedOf([made.task]), deps);
  return ok({ task: viewOf(scope, made.task, map, now), notice: settled.setByDone ? doneCheckNotice(settled.setByDone.at!, zone, settled.replaced) : null }, 201);
}

/** The measure parts a Done task's check rows read Better, Same or Worse since it last went Done. */
async function partsRead(scope: WorkScope, task: WorkTask, deps: WorkDeps): Promise<PartsRead> {
  const { rows } = await listTaskLog(scope.organisationId, task.region, task.id, { kind: "check" }, deps);
  const out: PartsRead = { first: false, then: false };
  for (const r of rows) {
    if (r.kind !== "check" || !r.check.read || r.check.read === "too_soon" || !r.check.which) continue;
    if (task.closedAt && r.at < task.closedAt) continue;
    out[r.check.which] = true;
  }
  return out;
}

/** Change a task: what the person sent, checked, then written with its change rows in one transaction. */
export async function editTask(scope: WorkScope, ref: number, body: EditTaskBody, deps: WorkDeps = {}): Promise<WorkResult<ChangeDone>> {
  const now = nowOf(deps);
  const found = await taskByRef(scope, ref, deps);
  if (!found) return refuse("not_found");
  // Checked against the task as the person's page showed it, so a stale tab or a second person never undoes a change.
  if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== found.updatedAt) return refuse("changed");
  let place = { brandId: found.brandId, region: found.region };
  if (body.brandId !== undefined) {
    const p = placeForChange(scope, found, body.brandId);
    if ("error" in p) return p;
    place = p;
  }
  const checked = await checkFields(scope, body, found, { ...place, addedFrom: found.addedFrom }, deps, now);
  if (!checked.ok) return checked;
  const zone = zoneForTask(scope, { brandId: place.brandId, addedFrom: found.addedFrom });
  const read = found.status === "done" && body.measure !== undefined ? await partsRead(scope, found, deps) : undefined;
  let settled: ReturnType<typeof settle> | null = null;
  const seen = stableJson(found);
  const plan = (cur: WorkTask): WorkChangePlan | null => {
    // Checked against the task as it was read: one changed since is refused, never merged.
    if (stableJson(cur) !== seen) throw new Changed();
    settled = settle(cur, checked.value.patch, checked.value.check, zone, now, read);
    return { patch: settled.patch };
  };
  let r;
  try {
    r = await changeWorkTask(scope.organisationId, found.id, found.region, plan, writeOf(scope, now, body.via), deps);
  } catch (err) {
    if (err instanceof Changed) return refuse("changed");
    throw err;
  }
  if (!r.ok && r.why === "not_found") return refuse("not_found");
  const task = r.ok ? r.task : r.task;
  const map = await lookupMap(scope, [task], wantedOf([task]), deps);
  const s = settled as ReturnType<typeof settle> | null;
  return ok({ task: viewOf(scope, task, map, now), notice: r.ok && s?.setByDone ? doneCheckNotice(s.setByDone.at!, zone, s.replaced) : null });
}

/** Delete a task (admins and owners): its log rows stay, with a "deleted" row. */
export async function removeTask(scope: WorkScope, ref: number, deps: WorkDeps = {}): Promise<WorkResult<{ deleted: true; ref: number }>> {
  if (!scope.canDelete) return refuse("forbidden_delete");
  const found = await taskByRef(scope, ref, deps);
  if (!found) return refuse("not_found");
  const r = await deleteWorkTask(scope.organisationId, found.id, found.region, writeOf(scope, nowOf(deps)), deps);
  return r.ok ? ok({ deleted: true as const, ref }) : refuse("not_found");
}

// --- Checks ------------------------------------------------------------------------------------

/**
 * Mark a check checked, look again, or read a measure's check:
 * - Mark checked (Review's Done) ends a date or task check; a measure's check takes a read instead.
 * - Look again (Review's Tomorrow) moves the check to a day, tomorrow at 08:00 unless one is given.
 * - A read (Better, Same, Worse, Too soon to tell) is taken only on a measure's check, with what
 *   Work counted kept on its row. Better, Same or Worse on the first measure sets the then's
 *   check; Too soon to tell asks again 7 days on.
 */
export async function actOnCheck(scope: WorkScope, body: CheckActionBody, deps: WorkDeps = {}): Promise<WorkResult<ChangeDone>> {
  const now = nowOf(deps);
  let task = await taskByRef(scope, body.ref, deps);
  if (!task) return refuse("not_found");
  if (!task.check) return refuse("no_check");
  // The check the page showed: once it has moved (answered elsewhere, moved, replaced), a stale tap is refused.
  if (body.setAt !== undefined && body.setAt !== task.check.setAt) return refuse("changed");
  const byMeasure = task.check.setBy === SET_BY_MEASURE;
  if (body.action === "checked" && byMeasure) return refuse("measure_check_read");
  if (body.action === "read" && !byMeasure) return refuse("read_not_measure");
  if (body.action === "read") task = await countDueCheck(scope, task, deps);
  const zone = zoneForTask(scope, task);
  const seen = task;
  let notice: string | null = null;
  const plan = (cur: WorkTask): WorkChangePlan | null => {
    if (!cur.check || cur.check.setAt !== seen.check!.setAt || cur.check.setBy !== seen.check!.setBy) throw new Changed();
    const c = cur.check;
    const part = partOf(cur.measure, c.which);
    if (body.action === "read" && !part) throw new Changed();
    const onMeasure = c.setBy === SET_BY_MEASURE && part !== null;
    let next: WorkCheck | null = null;
    if (body.action === "look_again") next = lookAgain(c, { by: scope.userId, timeZone: zone, now, day: body.day, time: body.time });
    if (body.action === "read") next = checkAfterRead(c, body.read!, { measure: cur.measure, closedAt: cur.closedAt, timeZone: zone, now, day: body.day, time: body.time });
    const row: WorkCheckRow = {
      action: body.action,
      kind: c.kind,
      at: c.at,
      next: next?.at ?? null,
      measureKind: onMeasure ? part!.kind : null,
      which: onMeasure ? c.which : null,
      counted: onMeasure ? (c.counted ?? null) : null,
      read: body.action === "read" ? body.read! : null,
    };
    if (next) notice = body.read === "too_soon" ? askAgainNotice(next.at!, zone) : next.which === "then" && c.which === "first" ? thenCheckNotice(next.at!, zone) : nextCheckNotice(next.at!, zone);
    return { patch: { check: next }, checkRow: row };
  };
  let r;
  try {
    r = await changeWorkTask(scope.organisationId, task.id, task.region, plan, writeOf(scope, now, body.via), deps);
  } catch (err) {
    if (err instanceof Changed) return refuse("changed");
    throw err;
  }
  if (!r.ok && r.why === "not_found") return refuse("not_found");
  const done = r.ok ? r.task : r.task;
  const map = await lookupMap(scope, [done], wantedOf([done]), deps);
  return ok({ task: viewOf(scope, done, map, now), notice });
}

// --- Decisions ---------------------------------------------------------------------------------

/** Who recommended a pick: only ever from a stored draft (Vizzy's, later a coding agent's), never from a request. */
export type Recommended = NonNullable<WorkDecision["recommended"]>;

/**
 * Record a decision on a task, append only: a changed mind is a new row that may name the one it
 * replaces. A plan approval ("Approve the plan": Approve, Change it, Not now) needs the plan link
 * with that url and version on the task, takes no recommendation, and so is refused when drafted.
 */
export async function recordDecision(
  scope: WorkScope,
  body: DecisionBody,
  deps: WorkDeps = {},
  opts: { recommended?: Recommended | null; tool?: string; draft?: DraftedSave & { taskId: string } } = {},
): Promise<WorkResult<{ row: WorkLogRowOf<"decision">; plans: ReturnType<typeof planStates> }>> {
  const now = nowOf(deps);
  const task = await taskByRef(scope, body.ref, deps);
  if (!task) return refuse("not_found");
  // A draft answers the task it was drafted on, and is never a plan approval.
  if (opts.draft && opts.draft.taskId !== task.id) return refuse("draft_missing");
  if (opts.draft && body.plan) return refuse("plan_recommended");
  const decisions = await listTaskDecisions(scope.organisationId, task.region, task.id, deps);
  if (decisions.length >= WORK_LIMITS.decisions) return refuse("decisions_full");
  // A changed mind answers the row it replaces: what that row stored (its question, options, plan
  // link and recommendation) is carried over from the store, never taken from the request.
  const replaced = body.replaces ? decisions.find((d) => d.id === body.replaces) : undefined;
  if (body.replaces && !replaced) return refuse("replaces_missing");
  if (replaced && Boolean(body.plan) !== Boolean(replaced.decision.plan)) return refuse("replaces_other");
  let decision: WorkDecision;
  if (body.plan) {
    if (opts.recommended) return refuse("plan_recommended");
    if (body.question !== undefined && !isPlanApprovalQuestion(body.question)) return refuse("plan_question");
    const fixed = PLAN_APPROVAL_OPTIONS.map((o) => o.label as string);
    if (body.options && (body.options.length !== fixed.length || body.options.some((o, i) => o !== fixed[i]))) return refuse("plan_choice");
    if (!body.chosen || !["a", "b", "c"].includes(body.chosen)) return refuse("plan_choice");
    const plan = body.plan;
    const link = task.typedLinks.find((l) => l.kind === "plan" && l.url === plan.url && (l.version ?? null) === (plan.version ?? null));
    if (!link) return refuse("plan_link_missing");
    const was = replaced?.decision.plan;
    if (was && (was.url !== plan.url || (was.version ?? null) !== (plan.version ?? null))) return refuse("replaces_other");
    decision = {
      question: PLAN_APPROVAL_QUESTION,
      options: PLAN_APPROVAL_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
      recommended: null,
      chosen: { option: body.chosen, by: scope.userId },
      agreed: null,
      why: body.why || null,
      replaces: body.replaces ?? null,
      plan: { url: plan.url, ...(plan.version ? { version: plan.version } : {}) },
    };
  } else {
    if (isPlanApprovalQuestion(body.question!)) return refuse("plan_question");
    let question = body.question!;
    let options = body.options!.map((label, i) => ({ id: DECISION_OPTION_IDS[i]!, label }));
    let recommended = opts.recommended ?? null;
    if (replaced) {
      const was = replaced.decision;
      const same = question.trim() === was.question && options.length === was.options.length && options.every((o, i) => o.label.trim() === was.options[i]!.label);
      if (!same) return refuse("replaces_other");
      question = was.question;
      options = was.options.map((o) => ({ ...o }));
      recommended = opts.recommended ?? was.recommended;
    }
    if (body.chosen && !options.some((o) => o.id === body.chosen)) return refuse("plan_choice", "The choice is one of the options.");
    const chosen = body.chosen ? { option: body.chosen, by: scope.userId } : null;
    decision = { question, options, recommended, chosen, agreed: agreedOf({ recommended, chosen }), why: body.why || null, replaces: body.replaces ?? null, plan: null };
  }
  const w = writeOf(scope, now, opts.draft?.tool ?? opts.tool);
  const input = { organisationId: scope.organisationId, brandId: task.brandId, region: task.region, day: w.day, at: w.at, source: w.source, kind: "decision" as const, taskId: task.id, decision };
  let saved: WorkLogRowOf<"decision">;
  if (opts.draft) {
    const r = await saveDraftedWorkLog(scope.ctx, { ...input, id: opts.draft.rowId }, opts.draft.accept, deps);
    if (!r.ok) return draftRefusal(r.error);
    saved = r.row as WorkLogRowOf<"decision">;
  } else {
    const [row] = await appendWorkLog([input], deps);
    saved = row as WorkLogRowOf<"decision">;
  }
  return ok({ row: saved, plans: planStates(task.typedLinks, [...decisions.filter((d) => d.id !== saved.id), saved]) }, 201);
}

// --- Import ------------------------------------------------------------------------------------

export interface ImportPreview {
  columns: Array<{ head: string; field: string }>;
  /** The first 20 rows as they would come in. */
  rows: Array<ImportRow & { statusLabel: string }>;
  total: number;
  refused: Array<{ row: number; problem: ImportRowProblem; message: string }>;
  unknownStatuses: string[];
  unknownText: string;
  nextRef: number;
  refHint: string;
}

export interface ImportDone {
  importId: string;
  imported: number;
  refused: Array<{ row: number; problem: ImportRowProblem; message: string }>;
  unknownStatuses: string[];
  nextRef: number;
}

const PREVIEW_ROWS = 20;

/** Read a Backlog tab and check every row: the rows and what would be refused, with nothing written. */
async function readImport(scope: WorkScope, body: ImportBody, deps: WorkDeps) {
  // The read stops one row past the cap, so a sheet past it is never read in full.
  const sheet = parseSheet(body.text, WORK_LIMITS.importRows);
  if (sheet.more || sheet.rows.length > WORK_LIMITS.importRows) return refuse("import_too_many");
  if (!sheet.rows.length) return refuse("import_empty");
  const columns = matchColumns(sheet.headers, body.mapping ?? {});
  if (!columns.some((c) => c.field === "title")) return refuse("import_no_title");
  const read = readSheet(sheet, columns);
  const fallback = placeForNew(scope, body.brandId);
  if ("error" in fallback) return fallback;
  // The counter first, then the tasks: an import that claims it (importTasks) is refused if anything
  // took a number or claimed it since, so the tasks read here are the ones its refs are checked against.
  const refs = await peekImportRefs(scope.organisationId, deps.controlDb, nowOf(deps));
  // Refs are per organisation: every task's, in every region, whatever the person sees.
  const [open, closed] = await Promise.all([
    listWorkTasks(scope.organisationId, { open: true }, deps),
    listWorkTasks(scope.organisationId, { open: false, limit: WORK_LIMITS.tasks }, deps),
  ]);
  const all = [...open.rows, ...closed.rows];
  const unanswered = [...open.unanswered, ...closed.unanswered];
  const taken = new Map(all.map((t) => [t.ref, t]));
  const refused: ImportDone["refused"] = read.problems.map((p) => ({ ...p, message: IMPORT_ROW_MESSAGES[p.problem] }));
  const rows: Array<ImportRow & { place: { brandId: string | null; region: Region } }> = [];
  for (const r of read.rows) {
    // A ref the counter gave out before the peek is taken even with no task to read yet: the write
    // that took it (a quick add, another import, a brand move) may still be on its way. One it gave
    // out after the peek makes the claim refuse.
    if (r.ref !== null && (taken.has(r.ref) || r.ref < refs.next)) {
      refused.push({ row: r.row, problem: "ref_taken", message: IMPORT_ROW_MESSAGES.ref_taken });
      continue;
    }
    let place: { brandId: string | null; region: Region } = fallback;
    if (r.brand) {
      const want = r.brand.trim().toLowerCase();
      const b = scope.brands.find((x) => x.id.toLowerCase() === want || x.name.trim().toLowerCase() === want);
      if (!b || (scope.view === "brand" && b.id !== scope.session.id)) {
        refused.push({ row: r.row, problem: "brand_unknown", message: IMPORT_ROW_MESSAGES.brand_unknown });
        continue;
      }
      place = { brandId: b.id, region: b.region };
    }
    rows.push({ ...r, place });
  }
  // A sheet's ref may run at most 5,000 past the refs Work has given, and never into the last
  // 5,000, so one row (ID 999999) can't use up the organisation's refs.
  const peek = refs.next;
  const ceiling = Math.min(MAX_WORK_REF - WORK_LIMITS.tasks, Math.max(peek - 1, ...all.map((t) => t.ref)) + WORK_LIMITS.tasks);
  const kept = rows.filter((r) => {
    if (r.ref === null || r.ref <= ceiling) return true;
    refused.push({ row: r.row, problem: "ref_far", message: IMPORT_ROW_MESSAGES.ref_far });
    return false;
  });
  refused.sort((a, b) => a.row - b.row);
  const highest = Math.max(0, ...kept.map((r) => r.ref ?? 0));
  const next = Math.max(peek, highest + 1);
  return { ok: true as const, columns, rows: kept, refused, unknownStatuses: read.unknownStatuses, taken, highest, next, unanswered, refs };
}

/** The import dialog's preview: what each column fills, the first 20 rows, and what would be refused. */
export async function previewImport(scope: WorkScope, body: ImportBody, deps: WorkDeps = {}): Promise<WorkResult<ImportPreview>> {
  if (!scope.canImport) return refuse("forbidden_import");
  const r = await readImport(scope, body, deps);
  if (!r.ok) return r;
  return ok({
    columns: r.columns,
    rows: r.rows.slice(0, PREVIEW_ROWS).map(({ place: _place, ...row }) => ({ ...row, statusLabel: WORK_STATUS_LABEL[row.status] })),
    total: r.rows.length,
    refused: r.refused,
    unknownStatuses: r.unknownStatuses,
    unknownText: unknownStatusesText(r.unknownStatuses),
    nextRef: r.next,
    refHint: refHintText(r.next),
  });
}

/**
 * Import a Backlog tab (admins and owners), up to 1,000 rows: each row a task whose origin is the
 * import and its row, its sheet ref kept (new refs start after the highest), a status Work doesn't
 * know as To do, and a Check column as a check at 08:00 brand time or on another task. A sheet with
 * refs of its own claims the counter before writing and lets go after (claimImportRefs), so two
 * imports, or an import and a quick add, never give two tasks one ref.
 */
export async function importTasks(scope: WorkScope, body: ImportBody, deps: WorkDeps = {}): Promise<WorkResult<ImportDone>> {
  if (!scope.canImport) return refuse("forbidden_import");
  const now = nowOf(deps);
  const r = await readImport(scope, body, deps);
  if (!r.ok) return r;
  if (r.unanswered.length) return refuse("regions_down");
  const { count } = await countWorkTasks(scope.organisationId, deps);
  if (count + r.rows.length > WORK_LIMITS.tasks) return refuse("tasks_full");
  const importId = newWorkImportId();
  const file = importFileName(body.file);
  const ownRefs = r.rows.some((x) => x.ref !== null);
  if (ownRefs) {
    if (r.refs.held) return refuse("import_busy");
    const claim = await claimImportRefs(scope.organisationId, { peek: r.refs, atLeast: r.highest, importId }, deps.controlDb, now);
    if (claim !== "claimed") return refuse("import_busy");
  }
  try {
    return await writeImport(scope, r, { importId, file, now }, deps);
  } finally {
    if (ownRefs) await releaseImportRefs(scope.organisationId, importId, deps.controlDb, now).catch((err) => console.warn("[work] letting go of the refs after an import failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown"));
  }
}

/** The import's writes, once its refs are its own: new refs for rows with none, then a task per row. */
async function writeImport(
  scope: WorkScope,
  r: Extract<Awaited<ReturnType<typeof readImport>>, { ok: true }>,
  o: { importId: string; file: string | null; now: Date },
  deps: WorkDeps,
): Promise<WorkResult<ImportDone>> {
  const { importId, file, now } = o;
  const fresh = r.rows.filter((x) => x.ref === null).length;
  const first = fresh ? await takeRefs(scope, fresh, deps, now) : 0;
  if (first === null) return refuse("refs_full");
  let nextNew = first;
  const ids = new Map<number, string>();
  const planned = r.rows.map((row) => {
    const ref = row.ref ?? nextNew++;
    const id = newWorkTaskId();
    ids.set(ref, id);
    return { row, ref, id };
  });
  const refused = [...r.refused];
  const write = writeOf(scope, now, "import");
  let imported = 0;
  await mapLimit(planned, 8, async ({ row, ref, id }) => {
    const zone = (brandIn(scope, row.place.brandId) ?? scope.session).timeZone;
    let check: WorkCheck | null = null;
    if (row.check?.kind === "date") {
      check = { kind: "date", at: morningOf(row.check.day, zone), taskId: null, note: "", setBy: scope.userId, setAt: write.at, which: null, counted: null };
    } else if (row.check?.kind === "after_task") {
      // Only a task the person sees, as on the add page: a hidden one is left out like a ref that isn't there.
      const known = r.taken.get(row.check.ref);
      const target = ids.get(row.check.ref) ?? (known && seesTask(scope, known) ? known.id : undefined);
      if (target && target !== id) check = { kind: "after_task", at: null, taskId: target, note: "", setBy: scope.userId, setAt: write.at, which: null, counted: null };
    }
    try {
      await createWorkTask(
        {
          id,
          organisationId: scope.organisationId,
          brandId: row.place.brandId,
          addedFrom: scope.session.id,
          region: row.place.region,
          ref,
          title: row.title,
          description: row.description,
          notes: row.notes,
          status: row.status,
          stage: row.stage,
          mustHave: row.mustHave,
          links: row.links,
          blockedBy: [],
          waitingOn: null,
          ideaId: null,
          ideaBrandId: null,
          clipping: null,
          typedLinks: [],
          measure: null,
          origin: { kind: "import", by: scope.userId, importId, row: row.row, ...(file ? { file } : {}) },
          check,
          closedAt: isClosedStatus(row.status) ? write.at : null,
        },
        write,
        deps,
      );
      imported += 1;
    } catch (err) {
      console.warn("[work] an imported row failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown");
      refused.push({ row: row.row, problem: "failed", message: IMPORT_ROW_MESSAGES.failed });
    }
  });
  refused.sort((a, b) => a.row - b.row);
  return ok({ importId, imported, refused, unknownStatuses: r.unknownStatuses, nextRef: await peekWorkRefs(scope.organisationId, deps.controlDb) }, 201);
}

/** The caps a day's Log writes check: entries written in the organisation today, in every region. */
export async function entriesToday(scope: WorkScope, day: string, deps: WorkDeps): Promise<number> {
  return (await countWorkLog(scope.organisationId, { day, kind: "entry" }, deps)).count;
}

/** The brands a task may be tagged with, for the add page's picker: whole business only where allowed. */
export function brandChoices(scope: WorkScope): { wholeBusiness: boolean; brands: WorkBrand[] } {
  return { wholeBusiness: scope.view === "organisation", brands: scope.view === "brand" ? [scope.session] : scope.brands };
}
