import { ideaWord } from "@/lib/nav/terms";
import { stageById } from "./stages";
import { dayIn } from "./schedule";
import { dayOf } from "./words";
import { lookWords, WORK_STATUS_TONE, winLine, type WorkTone } from "./screenWords";
import { LIST_KINDS, LIST_STATUSES, type WorkFilters } from "./inputs";
import { onOpenList, SET_BY_MEASURE, type WorkStatus, type WorkTask } from "./types";
import { WORK_STATUS_LABEL } from "./words";
import type { TaskMention } from "./service";

/**
 * Work's one list as the screen draws it (ADR-0020): the filters kept in the address, and each
 * task as a row. The service reads, filters and orders the tasks (src/lib/work/service.ts
 * listTasks); this only turns them into what a row shows. Pure: plain data and type imports, so
 * the filters work in the browser. Titles and notes are the team's own words, shown as they are.
 */

const DEFAULT_STATUS = "open";

/** A page's search params as plain pairs: a repeated key keeps its first value. */
export function queryOf(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string") q.set(k, one);
  }
  return q;
}

/** The address for the list with these filters: only what differs from the defaults. */
export function filtersHref(f: WorkFilters): string {
  const q = new URLSearchParams();
  if (f.brand) q.set("brand", f.brand);
  if (f.stage) q.set("stage", f.stage);
  if (f.status !== DEFAULT_STATUS) q.set("status", f.status);
  if (f.mustHave) q.set("must", "1");
  if (f.due) q.set("due", "1");
  if (f.kind) q.set("kind", f.kind);
  const s = q.toString();
  return s ? `/admin/work?${s}` : "/admin/work";
}

/** The filters with one changed, as an address. */
export function withFilter(f: WorkFilters, patch: Partial<WorkFilters>): string {
  return filtersHref({ ...f, ...patch });
}

/** Any filter set beyond Open. */
export function anyFilter(f: WorkFilters): boolean {
  return !!(f.brand || f.stage || f.status !== DEFAULT_STATUS || f.mustHave || f.due || f.kind);
}

/** The status filter's choices, in the order the select lists them. */
export const STATUS_CHOICES: ReadonlyArray<{ value: (typeof LIST_STATUSES)[number]; label: string }> = [
  { value: "open", label: "Open" },
  { value: "todo", label: WORK_STATUS_LABEL.todo },
  { value: "in_progress", label: WORK_STATUS_LABEL.in_progress },
  { value: "waiting", label: WORK_STATUS_LABEL.waiting },
  { value: "done", label: WORK_STATUS_LABEL.done },
  { value: "dropped", label: WORK_STATUS_LABEL.dropped },
  { value: "closed", label: "Done or dropped" },
  { value: "all", label: "Any status" },
];

/** The kind of win filter's choices. */
export const KIND_CHOICES: ReadonlyArray<{ value: (typeof LIST_KINDS)[number]; label: string }> = [
  { value: "used", label: "Used" },
  { value: "moves", label: "Moves a number" },
  { value: "runs_better", label: "Runs better" },
  { value: "done", label: "Done is the win" },
  { value: "none", label: "No measure yet" },
];

/** A row's check: what it says, and whether it is due now or only a forecast of the check Done will set. */
export interface RowCheck {
  label: string;
  due: boolean;
  measure: boolean;
  forecast: boolean;
}

/** One row of the list. */
export interface WorkRow {
  id: string;
  ref: number;
  href: string;
  title: string;
  status: WorkStatus;
  statusLabel: string;
  tone: WorkTone;
  /** Done or Dropped and off the Open list. */
  closed: boolean;
  mustHave: boolean;
  fromVizzy: boolean;
  /** The pull requests it links, as "#84". */
  prs: string[];
  stage: { n: number; label: string } | null;
  /** The brand's name, or null for the whole business. */
  brand: string | null;
  /** The idea it became, and the other ideas it touches, by name. */
  madeIdea: boolean;
  ideas: string[];
  /** The first open task it waits for. */
  waitingOn: { ref: number; title: string } | null;
  check: RowCheck | null;
  win: string | null;
}

export interface RowView {
  task: WorkTask;
  brandName: string | null;
  due: boolean;
  blockers: TaskMention[];
  waiting: boolean;
  checkTask: TaskMention | null;
  fromVizzy: boolean;
}

const isOpenStatus = (s: WorkStatus) => s !== "done" && s !== "dropped";

/** What a row's Check column says. */
export function rowCheck(v: RowView, timeZone: string, now: Date): RowCheck | null {
  const t = v.task;
  const c = t.check;
  if (c) {
    const measure = c.setBy === SET_BY_MEASURE;
    if (v.due) {
      const since = c.at ? dayIn(c.at, timeZone) : null;
      const today = dayIn(now, timeZone);
      const label = c.kind === "after_task" ? "Due now" : since && since < today ? `Due since ${dayOf(c.at!, timeZone)}` : "Due today";
      return { label, due: true, measure, forecast: false };
    }
    if (!t.open && !measure) return null;
    if (c.kind === "after_task") {
      const m = v.checkTask;
      return { label: m && "ref" in m ? `When #${m.ref} is done` : "When another task is done", due: false, measure, forecast: false };
    }
    return { label: c.at ? dayOf(c.at, timeZone) : "", due: false, measure, forecast: false };
  }
  // No check yet: a measure that looks by days forecasts the one Done sets.
  const m = t.measure;
  if (t.open && isOpenStatus(t.status) && m && m.kind !== "done" && "days" in m.look) {
    return { label: lookWords(m.look), due: false, measure: true, forecast: true };
  }
  return null;
}

/** A task as a row: names of ideas come from `ideaName` (brand and idea id), when the screen read them. */
export function rowOf(v: RowView, o: { timeZone: string; now: Date; ideaName?: (brandId: string, ideaId: string) => string | undefined; ideaWords?: boolean }): WorkRow {
  const t = v.task;
  const stage = t.stage ? stageById(t.stage) : undefined;
  const blocker = v.blockers.find((b): b is Extract<TaskMention, { ref: number }> => "ref" in b && isOpenStatus(b.status));
  const ideas = t.typedLinks.flatMap((l) => (l.kind === "idea" && !(l.ideaId === t.ideaId && l.brandId === t.ideaBrandId) ? [o.ideaName?.(l.brandId, l.ideaId) ?? ideaWord(o.ideaWords === true).A] : []));
  return {
    id: t.id,
    ref: t.ref,
    href: `/admin/work/${t.ref}`,
    title: t.title,
    status: t.status,
    statusLabel: WORK_STATUS_LABEL[t.status],
    tone: WORK_STATUS_TONE[t.status],
    closed: !onOpenList(t, o.now),
    mustHave: t.mustHave,
    fromVizzy: v.fromVizzy,
    prs: t.typedLinks.flatMap((l) => (l.kind === "pull_request" ? [`#${l.number}`] : [])),
    stage: stage ? { n: stage.n, label: stage.label } : null,
    brand: v.brandName,
    madeIdea: t.ideaId !== null,
    ideas,
    waitingOn: v.waiting && blocker ? { ref: blocker.ref, title: blocker.title } : null,
    check: rowCheck(v, o.timeZone, o.now),
    win: winLine(t.measure),
  };
}
