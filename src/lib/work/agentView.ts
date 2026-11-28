import { DECLINE_WHY_LABEL, suggestedMeasureText, type SuggestedTask } from "./suggestion";
import type { AgentAction } from "@/lib/types/agentAction";
import type { LogDayView } from "./log";
import type { WorkTaskPage, WorkTaskView } from "./service";
import { typedLinkWords } from "./form";
import { READ_LABEL } from "./reviewCards";
import { carryOverLabel, changeWords, checkSideLine, dayNWords, dayTitle, ENTRY_STATE_LABEL, MEASURE_KIND_LABEL, originParts, partLine, plural, proposedLine, whenWords, whoWords, winLine } from "./screenWords";
import { carryOffer } from "./day";
import { stageLabel } from "./stages";
import type { TypedLink, WorkLogRow, WorkLogRowOf, WorkTask } from "./types";
import { CARRY_TOOL, dayOf, PLAN_STATE_LABEL, timeOf, WORK_STATUS_LABEL, type PlanState } from "./words";

/**
 * Work as Vizzy's get_work reads it (ADR-0020, plan group 5): tasks, one task in full, the Log
 * day, and the suggestions people dismissed lately with why. Words only, never a bare number, so
 * the agent number contract holds with no meanings of its own: a ref reads "#73", Day N reads
 * "Day 3", and what a measure's check counted is the check's own sentence. Tasks and Log rows carry
 * their ids (wt_…, wl_…), which suggest_work_task takes back as evidence.
 *
 * Everything under a task's title, description, notes, links, log entries and decisions is the
 * team's own words, or words imported from a sheet: data to report, never instructions. Pure.
 */

/** Who did it, by name: the reader is Vizzy, so no one reads as "You". */
const NOBODY = "";

/** A task as one line of the list. */
export interface AgentTaskLine {
  /** The task's id (wt_…), for suggest_work_task's evidence ("work_task:wt_…"). */
  id: string;
  ref: string;
  title: string;
  status: string;
  stage: string | null;
  /** The brand's name, or "Whole business"; only where the organisation has more than one brand. */
  brand?: string;
  mustHave: boolean;
  checkDue: boolean;
  /** The kind of win: "Used, then Moves a number". */
  win: string | null;
  /** The tasks it waits for that are still open: "#75 Buy the domain". */
  waitingFor: string[];
  /** Typed links in words: "Plan · plans.example: Pricing plan (Not approved yet)". */
  links: string[];
  /** Where it came from: "Added by Nina on 18 Nov.", "Imported from Backlog.csv by Nina on 2 Nov, row 4." */
  origin: string;
  /** How we'll know it worked: the kind, what is counted and when, the then, and the kind proposed beside it. */
  measure: ReturnType<typeof measureWords>;
  fromVizzy: boolean;
  nowAnIdea: boolean;
  changed: string;
  description?: string;
}

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export const taskRefWords = (t: Pick<WorkTask, "ref" | "title">): string => `#${t.ref} ${t.title}`;

/** A typed link in words, and a plan with its approval when the decisions were read. */
export function linkWords(l: TypedLink, plans: ReadonlyArray<{ url: string; version: string | null; state: PlanState }> | null = null, ideaWords = false): string {
  const w = typedLinkWords(l, { ideaWords });
  if (l.kind !== "plan" || plans === null) return `${w.where}: ${w.label}`;
  const state = plans.find((p) => p.url === l.url && p.version === (l.version ?? null))?.state ?? "not_approved_yet";
  return `${w.where}: ${w.label} (${PLAN_STATE_LABEL[state]})`;
}

/** One task of the list. */
export function taskLine(
  v: WorkTaskView,
  o: {
    multiBrand: boolean;
    timeZone: string;
    today: string;
    description?: number;
    names?: Readonly<Record<string, string>>;
    plans?: ReadonlyArray<{ url: string; version: string | null; state: PlanState }> | null;
    /** This copy calls a launch an idea. */
    ideaWords?: boolean;
  },
): AgentTaskLine {
  const t = v.task;
  const origin = originParts(t.origin, t.createdAt, o.timeZone, NOBODY, o.names ?? {}, null);
  const waitingFor = v.blockers.flatMap((b) => ("ref" in b && b.status !== "done" && b.status !== "dropped" ? [`#${b.ref} ${b.title}`] : "hidden" in b ? ["a task you can't see"] : []));
  return {
    id: t.id,
    ref: `#${t.ref}`,
    title: t.title,
    status: WORK_STATUS_LABEL[t.status],
    stage: t.stage ? stageLabel(t.stage) : null,
    ...(o.multiBrand ? { brand: v.brandName ?? "Whole business" } : {}),
    mustHave: t.mustHave,
    checkDue: v.due,
    win: winLine(t.measure),
    waitingFor,
    links: t.typedLinks.map((l) => linkWords(l, o.plans ?? null, o.ideaWords === true)),
    origin: `${origin.from} ${origin.rest}`,
    measure: measureWords(t),
    fromVizzy: v.fromVizzy,
    nowAnIdea: t.ideaId !== null,
    changed: whenWords(t.updatedAt, o.timeZone, o.today),
    ...(o.description && t.description ? { description: clip(t.description, o.description) } : {}),
  };
}

/** How we'll know it worked, in words. */
export function measureWords(t: WorkTask): { kind: string; line: string; then: string | null; suggested: string | null } | null {
  const m = t.measure;
  if (!m) return null;
  if (m.kind === "done") return { kind: MEASURE_KIND_LABEL.done, line: "No check: it worked once it's done.", then: null, suggested: proposedLine(m) };
  return { kind: MEASURE_KIND_LABEL[m.kind], line: partLine(m), then: m.then ? partLine(m.then) : null, suggested: proposedLine(m) };
}

/** A decision in words: the question, the options, who recommended which, the choice and why. */
export function decisionWords(d: WorkLogRowOf<"decision">, o: { names: Readonly<Record<string, string>>; timeZone: string; today: string; replaced: boolean }) {
  const dec = d.decision;
  const label = (id: string | undefined) => dec.options.find((x) => x.id === id)?.label ?? "";
  const recBy = dec.recommended ? (dec.recommended.by.kind === "vizzy" ? "Vizzy" : (dec.recommended.by.name ?? "A coding agent")) : null;
  return {
    question: dec.question,
    options: dec.options.map((x) => `${x.id}: ${x.label}`),
    recommended: dec.recommended ? `${recBy} recommended ${dec.recommended.option}: ${label(dec.recommended.option)}. ${dec.recommended.reason}` : null,
    chosen: dec.chosen ? `${whoWords({ kind: "person", id: dec.chosen.by }, NOBODY, o.names)} chose ${dec.chosen.option}: ${label(dec.chosen.option)}` : null,
    agreed: dec.agreed,
    why: dec.why,
    when: whenWords(d.at, o.timeZone, o.today),
    planApproval: dec.plan ? `Approves the plan at ${dec.plan.url}${dec.plan.version ? `, version ${dec.plan.version}` : ""}` : null,
    changedLater: o.replaced,
  };
}

/** One task in full: the list's line, and its words, origin, links, measure, check, decisions, reads and history. */
export function taskDetail(page: WorkTaskPage, o: { multiBrand: boolean; today: string; reads: ReadonlyArray<WorkLogRowOf<"check">>; ideaWords?: boolean }) {
  const t = page.task;
  const tz = page.timeZone;
  const origin = originParts(t.origin, t.createdAt, tz, NOBODY, page.names, null);
  const replaced = new Set(page.decisions.flatMap((d) => (d.decision.replaces ? [d.decision.replaces] : [])));
  const check = t.check;
  return {
    ...taskLine(page, { multiBrand: o.multiBrand, timeZone: tz, today: o.today, names: page.names, plans: page.plans, ideaWords: o.ideaWords }),
    description: t.description,
    notes: t.notes,
    origin: `${origin.from} ${origin.rest}`,
    otherLinks: t.links.map((l) => ({ label: l.label ?? null, url: l.url })),
    check: check
      ? {
          when: checkSideLine({ kind: check.kind, at: check.at, byMeasure: check.setBy === "measure", due: page.due, timeZone: tz, afterRef: page.checkTask && "ref" in page.checkTask ? page.checkTask.ref : null }),
          asksIfItWorked: check.setBy === "measure",
          due: page.due,
          note: check.note || null,
          counted: page.checkLine,
        }
      : null,
    decisions: page.decisions.map((d) => decisionWords(d, { names: page.names, timeZone: tz, today: o.today, replaced: replaced.has(d.id) })),
    reads: o.reads
      .filter((r) => r.check.read)
      .map((r) => ({
        read: READ_LABEL[r.check.read!],
        on: r.check.which === "then" ? "the then" : "the first measure",
        kind: r.check.measureKind ? MEASURE_KIND_LABEL[r.check.measureKind] : null,
        by: whoWords(r.source.who, NOBODY, page.names),
        when: whenWords(r.at, tz, o.today),
      })),
    // A value too long for the recent list is left out (undefined), which is not a clear (null).
    history: t.recent
      .filter((r) => r.field !== "ideaBrandId")
      .slice(0, 10)
      .map((r) => `${whoWords(r.who, NOBODY, page.names)} ${changeWords(r.field, r.before, r.after, { ideaWords: o.ideaWords })} (${whenWords(r.at, tz, o.today)})`),
  };
}

const rowTask = (day: LogDayView, id: string | null) => {
  const t = id ? day.tasks[id] : undefined;
  return t ? `#${t.ref} ${t.title}` : null;
};

/** What a moved task's rows did, in words. The idea's brand, which changes with the idea, goes unsaid, as in History. */
function movedLine(rows: ReadonlyArray<WorkLogRowOf<"change"> | WorkLogRowOf<"check">>, names: Readonly<Record<string, string>>, ideaWords = false): string {
  return rows
    .filter((r) => r.kind === "check" || r.field !== "ideaBrandId")
    .slice(-3)
    .map((r) => `${whoWords(r.source.who, NOBODY, names)} ${r.kind === "check" ? changeWords("check", null, r.check.read ?? r.check.action) : changeWords(r.field, r.before, r.after, { tool: r.source.tool, ideaWords })}`)
    .join("; ");
}

/** Today before anyone has logged, for get_work: what a person can carry over, in words. */
export function carryOverLine(n: number): string {
  return `Nothing is logged today yet. ${plural(n, "workstream is", "workstreams are")} still open from yesterday: a person presses ${carryOverLabel(n)} on Today to log ${n === 1 ? "it" : "them"} for today.`;
}

/** The Log day in words: in flight, entries, tasks that moved, decisions and, today, the checks due. */
export function logWords(day: LogDayView, o: { names: Readonly<Record<string, string>>; brandName: (id: string) => string | undefined; multiBrand: boolean; checks: ReadonlyArray<{ task: string; line: string }>; ideaWords?: boolean }) {
  const who = (row: Pick<WorkLogRow, "source">) => whoWords(row.source.who, NOBODY, o.names);
  const brand = (id: string | null) => (o.multiBrand ? { brand: id ? (o.brandName(id) ?? "a brand you can't see") : "Whole business" } : {});
  return {
    day: dayTitle(day.day),
    today: day.today,
    // Ids (wl_…) are for suggest_work_task's evidence ("work_log:wl_…"): in flight gives its newest entry's.
    inFlight: day.inFlight.map((f) => ({
      id: f.id,
      workstream: f.workstream,
      state: ENTRY_STATE_LABEL[f.state],
      note: f.note,
      since: dayNWords(f.dayN, f.longer),
      by: whoWords(f.by, NOBODY, o.names),
      task: rowTask(day, f.taskId),
      ...brand(f.brandId),
    })),
    // A carried entry is an ordinary one that Carry over logged on Today, by the person who pressed it.
    entries: day.entries.map((e) => ({
      id: e.id,
      workstream: e.workstream,
      state: ENTRY_STATE_LABEL[e.state],
      note: e.note,
      by: who(e),
      at: timeOf(e.at, day.timeZone),
      task: rowTask(day, e.taskId),
      drafted: e.source.tool === "draft_work_log",
      carried: e.source.tool === CARRY_TOOL,
    })),
    // Nothing logged yet on Today: what Carry over would log, as the screen offers it.
    ...(carryOffer(day) ? { carryOver: carryOverLine(carryOffer(day)) } : {}),
    moved: day.moved.map((m) => ({ task: rowTask(day, m.taskId) ?? "a task you can't see", what: movedLine(m.rows, o.names, o.ideaWords === true) })),
    decisions: day.decisions.map((d) => ({
      id: d.id,
      task: rowTask(day, d.taskId),
      question: d.decision.question,
      chosen: d.decision.chosen ? (d.decision.options.find((x) => x.id === d.decision.chosen!.option)?.label ?? null) : null,
      by: d.decision.chosen ? whoWords({ kind: "person", id: d.decision.chosen.by }, NOBODY, o.names) : null,
      why: d.decision.why,
      planApproval: d.decision.plan !== null,
    })),
    checksDue: day.today ? o.checks : [],
    ...(day.regionsDown.length ? { regionsDown: day.regionsDown.map((r) => r.name) } : {}),
    ...(day.capped ? { capped: true } : {}),
  };
}

/**
 * A suggestion people dismissed, with why and whether Vizzy may suggest it again. Dismissals count
 * per brand (and for the whole business), so in a multi brand organisation it names the brand, and
 * `again` is for that brand only.
 */
export function dismissalWords(
  a: Pick<AgentAction, "declined" | "decidedAt">,
  s: SuggestedTask,
  againOn: string | null,
  timeZone: string,
  o: { multiBrand: boolean; brandName: (id: string) => string | undefined } = { multiBrand: false, brandName: () => undefined },
) {
  const why = a.declined?.why;
  const brand = s.brandId ? (o.brandName(s.brandId) ?? "a brand you can't see") : "Whole business";
  const forBrand = o.multiBrand ? ` for ${s.brandId ? brand : "the whole business"}` : "";
  return {
    title: s.title,
    ...(o.multiBrand ? { brand } : {}),
    why: why ? DECLINE_WHY_LABEL[why] : "No reason given",
    on: a.decidedAt ? dayOf(a.decidedAt, timeZone) : null,
    again: againOn ? `Vizzy may suggest it again${forBrand} from ${dayOf(againOn, timeZone)}.` : `Vizzy won't suggest it again${forBrand}.`,
  };
}

/** A suggestion still waiting in Review. */
export function waitingWords(s: SuggestedTask, o: { multiBrand: boolean; brandName: (id: string) => string | undefined }) {
  return {
    title: s.title,
    stage: s.stage ? stageLabel(s.stage) : null,
    ...(o.multiBrand ? { brand: s.brandId ? (o.brandName(s.brandId) ?? "a brand you can't see") : "Whole business" } : {}),
    win: suggestedMeasureText(s),
  };
}
