import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { sourceRepoUrl } from "@/lib/developers/flags";
import { FEATURE_LABELS, PLANS, type PlanFeature } from "@/lib/plans/catalog";
import { isUsageMeterEnabled } from "@/lib/plans/flags";
import { fleetCellId, readFleetCells } from "@/lib/tenant/fleetCells";
import { isoWeekStart } from "@/lib/tenant/loops";
import type { FirestoreLike } from "@/lib/tenant/types";
import { lastClosedWeek, weekBefore } from "./fold";
import { kindView, orgsView, roundTwo, showsThings, type KindView, type OrgsView } from "./fleetView";
import { lookName } from "./learnedWords";
import { BY_LEARNER, decisionKind, LOOP_RULES, LOOPS, type Decision, type DecisionKind, type LoopKind } from "./registry";
import { keyWords, kindLabel, reasonWords, unstampedWords } from "./reasonWords";
import { voteReasonLabel } from "./reasons";
import { HOLDBACK_ARMS, IMAGE_POOL, LOGGED_OWN_KINDS, ROW_KINDS, rowKindOf, rowLine, STAGES, STUCK_STEPS, type Stage, type StuckStep } from "./stages";
import { monthsUntilHoldbackReads } from "./verdict";
import { shortDay } from "./verdictWords";

/**
 * Settings › Loops (learning loops step 5, 4.7 of the plan for steps 4 and 5, screen 6): the
 * counts across every brand in this copy, for the people LOOPS_OPERATOR_EMAILS names, for closed
 * weeks only. It reads only the `fh:` rows of the last 2 closed weeks, by id, in one batched read
 * (the copy's `_orgs` row and one row per kind of choice, about 100 a week), and the pure LOOPS
 * lines. Every number goes through ./fleetView.ts, which applies the floors once: numbers of
 * things, shares and industry splits from 10 organisations, and counts of organisations below 10
 * in the four places question 4 names. Every kind shows by its label and every reason in words
 * (./reasonWords.ts); the raw keys stay in get_learning's data. Server only.
 */

/** The words the section shows that don't come from the counts. */
export const LOOPS_COPY = {
  title: "Loops",
  lead: "Counts across every brand in this copy, by organisation, for closed weeks. Only the people this copy's operator setting names see this.",
  weekGroup: "Week",
  empty: "Counts start after the first closed week.",
  error: "The counts didn't load. Try again in a minute.",
  behind: "Learning runs are behind. These counts come late, and a stuck plan below may be slow runs rather than learning.",
  coverage: "Coverage",
  stagesTitle: "How far each kind gets, in organisations",
  stagesNote: `Last ${LOOP_RULES.stallDays} days. Counts under 10 show here only and never set defaults.`,
  stagesHead: ["Kind and plan", "Declared", "Stamped", "Signalled", "Learning", "Checked", "Proven"],
  notYet: "Not yet",
  stuckTitle: "Where brands get stuck, by plan",
  stuckNone: "No organisation is stuck at Stamped or at Signalled.",
  stuckRule: `A brand is stuck when it stays at Stamped or at Signalled for ${LOOP_RULES.stallDays} days, or while ${LOOP_RULES.stallOutputs} more things are made there, whichever comes first. Amber means every organisation on that plan is stuck at that step. Declared to Stamped is use, not learning, and Learning to Checked is a wait.`,
  reasonsTitle: "Why learners didn't learn, in organisations",
  reasonsNone: `No learner turned a brand down in the last ${LOOP_RULES.stallDays} days.`,
  downsTitle: "Thumbs down by reason",
  downsNote: `This week. At most ${LOOP_RULES.orgOutputsCap} thumbs down per organisation per kind, rounded to 2 figures`,
  downsHead: ["Kind", "Organisations", "Thumbs down, by the reason given"],
  downsNone: "No thumbs down this week.",
  noReasonGiven: "No reason given",
  downsFoot: "Only image thumbs ask why. The notes people add stay with their brand and are never counted.",
  stampsTitle: "Stamp coverage this week",
  stampsNote: `Outputs count at most ${LOOP_RULES.orgOutputsCap} per organisation per kind, however they were made, rounded to 2 figures`,
  stampsHead: ["Kind", "Organisations", "Made", "Stamped", "Not stamped, top reason", "Lost"],
  fewer: "fewer than 10 organisations",
  fewerShort: "fewer than 10",
  cardsTitle: "Go back cards",
  holdbackTitle: "When the holdback could read",
  holdbackNoImages: `No images were made in the last ${LOOP_RULES.stallDays} days.`,
  holdbackOff: "Image learning isn't on for this copy, so images aren't counted here.",
  holdbackNoVotes: "No image votes this week.",
  holdbackNoLook: "No style has a learned look in use yet, so nothing is held back to compare.",
  industriesTitle: "Industries",
  industriesHead: ["Industry", "Organisations"],
  differsNone:
    "Where an industry differs: nothing yet. Industries are recorded from the onboarding follow up; an industry shows when it and the rest each have 10 organisations.",
  notLearningTitle: "Not learning",
  notLearningLink: "What each line means and why",
  groupOpen: "Open to see each line's stages",
  groupEmpty: "None yet",
  cleanupTitle: "Clean up",
  laterTag: "Later",
  later: [
    { title: "Doesn't fit us counts", text: "How often brands turn down a default learned across brands." },
    { title: "Connector health", text: "Connectors that stopped sending, by kind." },
  ],
} as const;

// ----- Shapes the page renders -----

export type Tone = "plain" | "faint" | "amber";
export interface Cell {
  v: string;
  tone: Tone;
}
export interface StagePlanRow {
  label: string;
  note: string;
  cells: Cell[];
}
export interface StageKindRow {
  label: string;
  note: string;
  /** Declared, Stamped, Signalled, Learning and Checked. */
  cells: Cell[];
  plans: StagePlanRow[];
}
export interface StageGroupLine {
  label: string;
  /** Declared and Stamped. */
  cells: Cell[];
  /** What the line can't reach, in words, across the other steps. */
  span: string;
}
export interface StageGroup {
  label: string;
  note: string;
  lines: StageGroupLine[];
}
export interface Chip {
  k: string;
  v: string;
  none?: boolean;
}
export interface DownRow {
  kind: string;
  pool: boolean;
  /** Null below the floor: the row reads "fewer than 10 organisations". */
  orgs: string | null;
  reasons: Chip[];
}
export interface StampRow {
  kind: string;
  /** Null below the floor. */
  cells: { orgs: string; made: string; pct: string; not: string; lost: string } | null;
}
export interface NotLearningGroup {
  label: string;
  note: string;
  over: string;
  open: boolean;
  lines: Array<{ label: string; why: string; when: string; over: boolean }>;
}
export interface LoopsData {
  behind: boolean;
  coverage: Array<{ k: string; v: string; amber: boolean }>;
  stages: StageKindRow[];
  groups: StageGroup[];
  stalls: Array<{ text: string; amber: boolean }>;
  waits: string[];
  reasons: Chip[];
  downs: DownRow[];
  stamps: StampRow[];
  cards: string[];
  holdback: string[];
  industries: Array<{ k: string; v: string; faint: boolean }>;
  differs: string[];
  notLearning: NotLearningGroup[];
  docsUrl: string;
  cleanup: string;
}
export interface LoopsWeekLink {
  week: string;
  label: string;
  on: boolean;
  /** No counts for it yet: shown, not a link. */
  off: boolean;
  href: string;
}
export type LoopsSectionView = { weeks: LoopsWeekLink[] } & ({ state: "error" } | { state: "empty" } | { state: "data"; data: LoopsData });

// ----- The read -----

/** The last 2 closed ISO weeks, newest first. */
export function loopsWeeks(now: Date): [string, string] {
  const last = lastClosedWeek(now);
  return [last, weekBefore(last)];
}

/** "Week of 3 May": the Monday it starts. */
export const weekLabel = (week: string): string => `Week of ${shortDay(isoWeekStart(week).toISOString())}`;

/** One closed week's rows: the copy's own and one per kind of choice (ROW_KINDS). */
export interface LoopsWeekRows {
  week: string;
  orgs: unknown;
  rows: ReadonlyMap<string, unknown>;
}

/** The rows of these weeks, by id, in one batched read: 1 + ROW_KINDS.length a week. */
export async function readLoopsWeeks(weeks: readonly string[], db?: FirestoreLike): Promise<LoopsWeekRows[]> {
  const per = 1 + ROW_KINDS.length;
  const ids = weeks.flatMap((w) => [fleetCellId.orgs(w), ...ROW_KINDS.map((r) => fleetCellId.kind(r, w))]);
  const docs = await readFleetCells(ids, db);
  return weeks.map((week, i) => {
    const slice = docs.slice(i * per, (i + 1) * per);
    return { week, orgs: slice[0]?.n, rows: new Map(ROW_KINDS.map((r, j) => [r, slice[j + 1]?.n])) };
  });
}

const PAGE = "/admin/account/loops";

/**
 * The section for the people who run the copy: the week asked for when it is one of the last 2
 * closed weeks, otherwise the newest of them with counts. The caller has checked LOOPS_ENABLED and
 * the operator gate.
 */
export async function loopsSection(input: { week?: string | null; now: Date; db?: FirestoreLike }): Promise<LoopsSectionView> {
  const weeks = loopsWeeks(input.now);
  let read: LoopsWeekRows[] | null = null;
  try {
    read = await readLoopsWeeks(weeks, input.db);
  } catch (err) {
    console.warn("[loops] the Loops section didn't load", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  const views = read?.map((r) => orgsView(r.orgs));
  // A week has counts once the lane wrote its row: organisations that reported, or only the brands
  // it listed and visited and its fold alarm, as when every brand's fold is behind. Then the
  // coverage rows and the behind banner show, never "Counts start after the first closed week".
  const hasData = (i: number) => {
    const v = views?.[i];
    return Boolean(v && (v.orgs > 0 || v.listed > 0 || v.visited > 0 || v.foldBehindWeeks !== null));
  };
  const asked = input.week ? weeks.indexOf(input.week) : -1;
  const at = asked >= 0 ? asked : Math.max(0, weeks.findIndex((_, i) => hasData(i)));
  const links = weeks.map((week, i) => ({ week, label: weekLabel(week), on: i === at, off: read !== null && !hasData(i), href: `${PAGE}?week=${week}` }));
  if (!read || !views) return { weeks: links, state: "error" };
  if (!hasData(at)) return { weeks: links, state: "empty" };
  return {
    weeks: links,
    state: "data",
    data: loopsData(read[at]!, {
      meterOn: isUsageMeterEnabled(),
      imagesCounted: isImageStyleVersionsOn(),
      today: input.now,
      docsUrl: `${sourceRepoUrl()}/blob/main/docs/ONTOLOGY.md#learning`,
    }),
  };
}

// ----- Words for the counts -----

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const orgsWords = (n: number) => plural(n, "organisation", "organisations");
const STEP: Record<Stage, string> = { stamped: "Stamped", signalled: "Signalled", learning: "Learning", checked: "Checked" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Jan 2027" from a YYYY-MM-DD day. */
function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? ""} ${y}`;
}

const PLAN_ORDER: readonly string[] = ["free", "pro", "ultra", ...PLANS.map((p) => p.id), "granted", "open"];
const planRank = (k: string) => {
  const i = PLAN_ORDER.indexOf(k);
  return i < 0 ? PLAN_ORDER.length : i;
};
const orderPlans = (keys: Iterable<string>) => [...new Set(keys)].sort((a, b) => planRank(a) - planRank(b) || a.localeCompare(b));

/** A plan's name: the catalogue's, Granted for a brand with granted features, No plan otherwise. */
export function planLabel(key: string): string {
  const plan = PLANS.find((p) => p.id === key);
  if (plan) return plan.name;
  if (key === "granted") return "Granted";
  if (key === "open") return "No plan";
  return keyWords(key);
}
/** A plan's name inside a list: "Free 31, Pro 13, granted 1". */
const planInList = (key: string) => (key === "granted" || key === "open" ? planLabel(key).toLowerCase() : planLabel(key));
const breakdown = (byPlan: ReadonlyArray<[string, number]>) => byPlan.map(([p, n]) => `${planInList(p)} ${n}`).join(", ");

/** The image kinds the pool counts once. */
const POOL_KINDS = (Object.entries(LOOPS) as Array<[LoopKind, Decision]>).filter(([, d]) => "loop" in d && d.loop.pool === IMAGE_POOL).length;

/** A row's note beside its label, for the rows that learn. */
const ROW_NOTES: Record<string, string> = {
  [IMAGE_POOL]: `the ${POOL_KINDS} image kinds`,
  edit_mode: "Memory Bank, learns its own way",
  content_write: "LinkedIn and X posts, learns its own way",
};

/** A plan feature a row needs before it can be made at all, so a plan without it never reaches Stamped: that is the plan, not a stall. */
const ROW_NEEDS: Partial<Record<string, PlanFeature>> = { edit_mode: "edit_vizzy" };

/** What "no person signal" means for a row stuck at Stamped. */
const NO_SIGNAL: Record<string, string> = {
  [IMAGE_POOL]: "with no votes",
  content_write: "with no post kept or edited",
  edit_mode: "with no edits reaching the learner",
};
const noSignal = (row: string) => NO_SIGNAL[row] ?? "with nothing kept, edited or turned down";

/** The rows that learn, shown first with their plans: the image pool, then the Memory Bank lines in their order, then the rest. */
const topRank = (r: string) => (r === IMAGE_POOL ? -1 : (LOGGED_OWN_KINDS as readonly string[]).includes(r) ? (LOGGED_OWN_KINDS as readonly string[]).indexOf(r) : LOGGED_OWN_KINDS.length);
const TOP_ROWS: readonly string[] = ROW_KINDS.filter((r) => rowLine(r).learns).sort((a, b) => topRank(a) - topRank(b));

const num = (n: number, tone: Tone = "plain"): Cell => ({ v: String(n), tone });
const NO_CHECK: Cell = { v: "No check", tone: "faint" };

const topOf = (c: Record<string, number>): [string, number] | null =>
  Object.entries(c)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? null;

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

/** Months as a person reads them. */
function monthsWords(m: number): string {
  if (m < 1) return "under a month";
  if (m >= 120) return "more than 10 years";
  const r = Math.round(m);
  return `about ${plural(r, "month", "months")}`;
}

/** Each row's stage cells: Declared, then the steps it reached, with an amber cell after a step a whole plan is stuck at. */
function stageCells(row: string, declared: number, reached: Record<Stage, number>, amberAfter: readonly StuckStep[] = []): Cell[] {
  const line = rowLine(row);
  const amber = new Set(amberAfter.map((s) => STAGES[STAGES.indexOf(s) + 1]));
  return [num(declared), ...STAGES.map((s) => (s === "checked" && !line.checks ? NO_CHECK : num(reached[s], amber.has(s) ? "amber" : "plain")))];
}

function stageRows(ov: OrgsView, views: ReadonlyMap<string, KindView>): StageKindRow[] {
  return TOP_ROWS.map((row) => {
    const kv = views.get(row)!;
    const need = ROW_NEEDS[row];
    const plans = orderPlans([...Object.keys(ov.plans), ...Object.keys(kv.plans)]).map((p) => {
      const stall = kv.plans[p];
      const reached = stall?.reached ?? { stamped: 0, signalled: 0, learning: 0, checked: 0 };
      const plan = PLANS.find((x) => x.id === p);
      const lacks = need && plan && !(plan.features as readonly string[]).includes(need);
      return { label: planLabel(p), note: lacks ? `no ${FEATURE_LABELS[need]}` : "", cells: stageCells(row, ov.plans[p] ?? 0, reached, stall?.amber) };
    });
    return { label: kindLabel(row), note: ROW_NOTES[row] ?? "", cells: stageCells(row, ov.orgs, kv.stages), plans };
  });
}

/** Every line that isn't a pool or a logged own line, grouped by what it says, gaps by revisit date. */
function lineGroups(): Array<{ decision: Exclude<DecisionKind, "learns">; kinds: LoopKind[] }> {
  const all = Object.entries(LOOPS) as Array<[LoopKind, Decision]>;
  const of = (k: DecisionKind) => all.filter(([kind, d]) => decisionKind(d) === k && !(LOGGED_OWN_KINDS as readonly string[]).includes(kind));
  const gaps = of("gap").sort((a, b) => ("gap" in a[1] ? a[1].revisit : "").localeCompare("gap" in b[1] ? b[1].revisit : "") || a[0].localeCompare(b[0]));
  return [
    { decision: "own", kinds: of("own").map(([k]) => k) },
    { decision: "gap", kinds: gaps.map(([k]) => k) },
    { decision: "none", kinds: of("none").map(([k]) => k) },
    { decision: "fleet", kinds: of("fleet").map(([k]) => k) },
  ];
}

const GROUP_NAME: Record<Exclude<DecisionKind, "learns">, string> = { own: "Own", gap: "Gap", none: "None", fleet: "Fleet only" };
const GROUP_SPAN: Record<Exclude<DecisionKind, "learns">, string> = { own: "Learns its own way", gap: "Should learn, not yet", none: "Never learns", fleet: "Counted only" };
const groupLabel = (d: Exclude<DecisionKind, "learns">, n: number) => `${GROUP_NAME[d]}, ${d === "own" && TOP_ROWS.some((r) => r !== IMAGE_POOL) ? `${n} more` : n} ${n === 1 ? "line" : "lines"}`;

function stageGroups(ov: OrgsView, views: ReadonlyMap<string, KindView>): StageGroup[] {
  return lineGroups().map(({ decision, kinds }) => ({
    label: groupLabel(decision, kinds.length),
    note: kinds.length ? LOOPS_COPY.groupOpen : LOOPS_COPY.groupEmpty,
    lines: kinds.map((kind) => {
      const row = rowKindOf(kind);
      const own = row === kind ? views.get(row) : undefined;
      return {
        label: kindLabel(kind),
        cells: [num(ov.orgs), own ? num(own.stages.stamped) : { v: `With ${kindLabel(row ?? kind)}`, tone: "faint" as const }],
        span: GROUP_SPAN[decision],
      };
    }),
  }));
}

function notLearning(today: Date): NotLearningGroup[] {
  const day = today.toISOString().slice(0, 10);
  const above = TOP_ROWS.filter((r) => r !== IMAGE_POOL).map(kindLabel);
  const NOTES: Record<Exclude<DecisionKind, "learns">, string> = {
    own: `Learn in their own way, such as the brand map's dismissed names.${above.length ? ` ${above.join(" and ")} ${above.length === 1 ? "is" : "are"} above.` : ""}`,
    gap: "Should learn, not yet: each with its reason and a date to look again.",
    none: "Never learn, each with why: a fact, a person's own choice, or a learner itself.",
    fleet: "Counted across brands and improved only by a pull request.",
  };
  return lineGroups().map(({ decision, kinds }) => {
    const lines = kinds.map((kind) => {
      const d = LOOPS[kind] as Decision;
      const why = "own" in d ? d.why : "gap" in d ? d.gap : "none" in d ? d.none : "fleet" in d ? d.fleet : "";
      const revisit = "gap" in d ? d.revisit : null;
      const over = revisit !== null && revisit < day;
      return { label: kindLabel(kind), why, when: revisit ? `${over ? "Overdue, " : ""}${longDay(revisit)}` : "", over };
    });
    const overdue = lines.filter((l) => l.over).length;
    return { label: groupLabel(decision, kinds.length), note: NOTES[decision], over: overdue ? `${overdue} overdue` : "", open: decision === "gap" && lines.length > 0, lines };
  });
}

/** Where brands get stuck: a line for each plan stuck whole (amber), then one for the rest of each kind. */
function stallLines(views: ReadonlyMap<string, KindView>): Array<{ text: string; amber: boolean }> {
  const out: Array<{ text: string; amber: boolean }> = [];
  const rest: Array<{ text: string; amber: boolean }> = [];
  for (const row of TOP_ROWS) {
    const kv = views.get(row)!;
    const label = kindLabel(row);
    const plans = orderPlans(Object.keys(kv.plans));
    const whole = new Set<string>();
    for (const p of plans) {
      const stall = kv.plans[p]!;
      for (const step of stall.amber) {
        whole.add(`${p}:${step}`);
        const n = stall.reached[step];
        const next = STAGES[STAGES.indexOf(step) + 1]!;
        const top = topOf(stall.why[step]);
        const who = n === 1 ? "the 1 organisation that reached" : `all ${n} organisations that reached`;
        out.push({
          amber: true,
          text: `${label}, ${planLabel(p)}: ${who} ${STEP[step]} ${n === 1 ? "is" : "are"} stuck there, none ${STEP[next]} for ${LOOP_RULES.stallDays} days.${top ? ` Top reason: ${reasonWords(top[0], "inline")} (${top[1]}).` : ""}`,
        });
      }
    }
    const byStep = Object.fromEntries(
      STUCK_STEPS.map((step) => [step, plans.filter((p) => !whole.has(`${p}:${step}`) && kv.plans[p]!.stuck[step] > 0).map((p) => [p, kv.plans[p]!.stuck[step]] as [string, number])]),
    ) as Record<StuckStep, Array<[string, number]>>;
    // A plan stuck whole at a step has its own amber line, so the rest of that step is no total.
    const amberAt = (step: StuckStep) => plans.some((p) => whole.has(`${p}:${step}`));
    // Each organisation once (`stuck.<step>.all`): one whose brands are on two plans is in both
    // plans' counts. A row written before that cell existed falls back to the plans added up.
    const total = (step: StuckStep) => {
      const sum = byStep[step].reduce((n, [, k]) => n + k, 0);
      const all = kv.stuckAll[step];
      return all > 0 ? Math.min(all, sum) : sum;
    };
    const whyAt = (step: StuckStep) => {
      const c: Record<string, number> = {};
      for (const [p] of byStep[step]) addCounts(c, kv.plans[p]!.why[step]);
      return topOf(c);
    };
    const pairs = STUCK_STEPS.flatMap((step) => byStep[step].map(([p, n]) => ({ step, p, n })));
    if (pairs.length === 0) continue;
    if (pairs.length === 1) {
      const { step, p, n } = pairs[0]!;
      const top = whyAt(step);
      rest.push({
        amber: false,
        text: `${label}, ${planLabel(p)}: ${n} of the ${orgsWords(kv.plans[p]!.reached[step])} that reached ${STEP[step]} ${n === 1 ? "is" : "are"} stuck there.${top ? ` Top reason: ${reasonWords(top[0], "inline")} (${top[1]}).` : ""}`,
      });
      continue;
    }
    const atStamped = byStep.stamped.length > 0;
    const atSignalled = byStep.signalled.length > 0;
    const top = whyAt("signalled");
    // With a plan in amber at the step, the other plans only, never a total that leaves it out.
    const howMany = (step: StuckStep) => (amberAt(step) ? "organisations on other plans" : orgsWords(total(step)));
    const stamped = `${howMany("stamped")} stuck at Stamped ${noSignal(row)} (${breakdown(byStep.stamped)})`;
    const signalled = `${amberAt("signalled") ? "others" : total("signalled")} at Signalled (${breakdown(byStep.signalled)})`;
    const why = top ? ` Top reason at Signalled: ${reasonWords(top[0], "inline")} (${top[1]}).` : "";
    const noneAt = (step: StuckStep) => (amberAt(step) ? ` No other plan stuck at ${STEP[step]}.` : ` None stuck at ${STEP[step]}.`);
    const text =
      atStamped && atSignalled
        ? `${label}: ${stamped}, and ${signalled}.${why}`
        : atStamped
          ? `${label}: ${stamped}.${noneAt("signalled")}`
          : `${label}: ${howMany("signalled")} stuck at Signalled (${breakdown(byStep.signalled)}).${noneAt("stamped")}${why}`;
    rest.push({ amber: false, text });
  }
  // Stuck at Stamped because nothing could count: the posts went out with no AI draft kept to compare.
  for (const row of TOP_ROWS) {
    const n = views.get(row)!.stuckNoDraft;
    if (n > 0) rest.push({ amber: false, text: `${kindLabel(row)}: ${orgsWords(n)} stuck at Stamped kept no AI draft to compare, so nothing could count as kept or edited.` });
  }
  return [...out, ...rest];
}

/** The wait for a first check, for rows the verdict reads: it keeps the floor. */
function waitLines(views: ReadonlyMap<string, KindView>): string[] {
  const out: string[] = [];
  for (const row of TOP_ROWS) {
    if (!rowLine(row).checks) continue;
    const w = views.get(row)!.waiting;
    const label = kindLabel(row);
    if (w && w.orgs === 0) continue;
    if (!w || !showsThings(w.orgs)) {
      out.push(`${label}: fewer than 10 organisations are waiting for a first check.`);
      continue;
    }
    const m = w.longestMonths;
    const longest = m === null ? "" : m === 0 ? ", the longest waiting under a month" : m >= 24 ? ", the longest waiting 2 years or more" : `, the longest waiting ${plural(m, "month", "months")}`;
    out.push(`${label}: ${w.orgs} organisations have a learned look with no check yet${longest}. At a few votes a month a check takes months.`);
  }
  return out;
}

const made = (things: NonNullable<KindView["things"]>, signal: string) => Object.values(things.out).reduce((n, s) => n + (s[signal] ?? 0), 0);

function downRows(views: ReadonlyMap<string, KindView>): DownRow[] {
  const rows = ROW_KINDS.filter((r) => {
    const kv = views.get(r)!;
    return (r === IMAGE_POOL && kv.orgs > 0) || Object.keys(kv.things?.disliked ?? {}).length > 0;
  });
  return rows.map((row) => {
    const kv = views.get(row)!;
    const kind = row === IMAGE_POOL ? `${kindLabel(row)}, all ${POOL_KINDS} kinds` : kindLabel(row);
    // From 10 organisations that gave a thumbs down, not 10 that made things (`why.orgs`).
    if (!kv.things || !showsThings(kv.downOrgs)) return { kind, pool: row === IMAGE_POOL, orgs: null, reasons: [] };
    const given = Object.entries(kv.things.disliked).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const downs = Object.values(kv.things.out).reduce((n, s) => n + Math.max(0, (s.voted ?? 0) - (s.liked ?? 0)), 0);
    const none = roundTwo(Math.max(0, downs - given.reduce((n, [, k]) => n + k, 0)));
    const reasons: Chip[] = given.map(([k, n]) => ({ k: voteReasonLabel("image", "down", k) ?? keyWords(k), v: String(n) }));
    if (none > 0) reasons.push({ k: LOOPS_COPY.noReasonGiven, v: String(none), none: true });
    return { kind, pool: row === IMAGE_POOL, orgs: String(kv.downOrgs), reasons };
  });
}

function stampRows(views: ReadonlyMap<string, KindView>): StampRow[] {
  const rows = ROW_KINDS.filter((r) => views.get(r)!.stages.stamped > 0).sort((a, b) => {
    const top = Number(TOP_ROWS.includes(b)) - Number(TOP_ROWS.includes(a));
    return top || TOP_ROWS.indexOf(a) - TOP_ROWS.indexOf(b) || views.get(b)!.stages.stamped - views.get(a)!.stages.stamped || kindLabel(a).localeCompare(kindLabel(b));
  });
  return rows.map((row) => {
    const kv = views.get(row)!;
    const t = kv.things;
    if (!t) return { kind: kindLabel(row), cells: null };
    const m = roundTwo(made(t, "made"));
    const { stamp_lost: lost = 0, ...unstamped } = t.unstamped;
    const top = topOf(unstamped);
    return {
      kind: kindLabel(row),
      cells: {
        orgs: String(kv.weekOrgs),
        made: m > 0 ? `about ${m}` : "0",
        pct: t.coverage === null ? "none saved" : `${Math.floor(t.coverage * 100)}%`,
        not: top ? `${unstampedWords(top[0])} ${top[1]}` : "none",
        lost: String(lost),
      },
    };
  });
}

const CARD_ORDER = ["proposed", "acted", "declined", "expired", "ignored"];
const cardRank = (k: string) => {
  const i = CARD_ORDER.indexOf(k);
  return i < 0 ? CARD_ORDER.length : i;
};

function cardLines(views: ReadonlyMap<string, KindView>): string[] {
  let orgs = 0;
  const cards: Record<string, number> = {};
  const declined: Record<string, number> = {};
  let cardsShown = false;
  /** A kind with declines by reason from fewer than 10 organisations that gave one, which can't show. */
  let hidden = false;
  for (const row of ROW_KINDS) {
    const kv = views.get(row)!;
    orgs += kv.cardOrgs;
    // Declines by reason show from 10 organisations that gave a reason (`declined.orgs`), not 10
    // that made things, so one organisation's reasons never show behind others' images.
    if (kv.things && showsThings(kv.declineOrgs)) addCounts(declined, kv.things.declined);
    else if (kv.declineOrgs > 0) hidden = true;
    if (!kv.things) continue;
    if (kv.cardOrgs > 0 || Object.keys(kv.things.cards).length) {
      cardsShown = true;
      addCounts(cards, kv.things.cards);
    }
  }
  const out = [`Organisations with a Go back card in the last ${LOOP_RULES.stallDays} days: ${orgs || "none"}.`];
  if (orgs > 0) {
    const what = Object.entries(cards).sort((a, b) => cardRank(a[0]) - cardRank(b[0]) || a[0].localeCompare(b[0]));
    if (!cardsShown) out.push(`What happened to them this week: ${LOOPS_COPY.fewer}.`);
    else if (what.length) out.push(`What happened to them this week: ${what.map(([k, n]) => `${keyWords(k).toLowerCase()} ${n}`).join(", ")}.`);
  }
  const why = Object.entries(declined).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Until a kind has 10 organisations that gave a reason, none is shown, nor "none": 0 is under 10 too.
  const rest = hidden ? `; other kinds have ${LOOPS_COPY.fewer}` : "";
  out.push(why.length ? `Declines by reason: ${why.map(([k, n]) => `${keyWords(k)} ${n}`).join(", ")}${rest}.` : `Declines by reason: ${LOOPS_COPY.fewer}.`);
  return out;
}

/** Weeks a month, for a week's counts as a month's pace. */
const WEEKS_A_MONTH = 52 / 12;

/**
 * When the holdback could read, per image style, from this week's counts across the copy: the
 * check (liked, from votes) and the guard (remade, from images made), whichever needs longer,
 * at the votes learner's band. A style shows only from 10 organisations behind its own numbers.
 */
function holdbackLines(views: ReadonlyMap<string, KindView>, imagesCounted: boolean): string[] {
  const kv = views.get(IMAGE_POOL);
  // An empty pool still says why, so the box never stands empty under its heading.
  if (!kv || kv.orgs === 0) return [imagesCounted ? LOOPS_COPY.holdbackNoImages : LOOPS_COPY.holdbackOff];
  if (!kv.things) return ["Fewer than 10 organisations made images, so this can't be worked out yet."];
  const band = BY_LEARNER.votes.band;
  const styles = Object.entries(kv.things.scope)
    .map(([style, byArm]) => {
      const sum = (s: string) => [...HOLDBACK_ARMS].reduce((n, arm) => n + (byArm[arm]?.[s] ?? 0), 0);
      return { style, voted: sum("voted"), liked: sum("liked"), made: sum("made"), remade: sum("remade") };
    })
    .filter((s) => s.voted > 0 || s.made > 0)
    .sort((a, b) => b.voted - a.voted || b.made - a.made || a.style.localeCompare(b.style));
  const out: string[] = [];
  let few = 0;
  for (const s of styles) {
    if (!showsThings(kv.styleOrgs[s.style] ?? 0)) {
      few += 1;
      continue;
    }
    const name = lookName(`image_style.${s.style}`);
    // The organisations behind this style's own numbers, not every one that made images.
    const across = `across ${kv.styleOrgs[s.style]} organisations`;
    const votes = s.voted * WEEKS_A_MONTH;
    const images = s.made * WEEKS_A_MONTH;
    const check = s.voted > 0 ? monthsUntilHoldbackReads({ perMonth: votes, rate: Math.min(1, s.liked / s.voted), band }) : null;
    const guard = s.made > 0 ? monthsUntilHoldbackReads({ perMonth: images, rate: Math.min(1, s.remade / s.made), band }) : null;
    if (check !== null && (guard === null || check >= guard)) {
      out.push(`${name}: ${monthsWords(check)} at ${roundTwo(votes)} votes a month ${across}${guard !== null ? ` (the remake check alone: ${monthsWords(guard)})` : ""}.`);
    } else if (guard !== null) {
      out.push(`${name}: ${monthsWords(guard)} for the remake check at ${roundTwo(images)} images a month ${across}${check !== null ? ` (the likes check alone: ${monthsWords(check)})` : " (no votes this week)"}.`);
    }
  }
  if (!styles.length) {
    // Votes on images made with no learned look yet (arm none) are votes too: nothing is held back from them.
    const voted = Object.values(kv.things.out).some((sig) => (sig.voted ?? 0) > 0);
    return [voted ? LOOPS_COPY.holdbackNoLook : LOOPS_COPY.holdbackNoVotes];
  }
  if (few) out.push(out.length ? "Other styles: fewer than 10 organisations each." : "Every style: fewer than 10 organisations each.");
  out.push("From this week's counts, at the pace of the organisations behind each style; a style shows only from 10 of them.");
  return out;
}

function industryRows(ov: OrgsView): Array<{ k: string; v: string; faint: boolean }> {
  return Object.entries(ov.industryCounts)
    .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1) || a[0].localeCompare(b[0]))
    .map(([k, n]) => ({ k: keyWords(k), v: n === null ? LOOPS_COPY.fewerShort : String(n), faint: n === null }));
}

/** A row's band, for where an industry differs: its learning line's own, or the votes learner's. */
function bandOf(row: string): number {
  for (const [kind, d] of Object.entries(LOOPS) as Array<[LoopKind, Decision]>) if (rowKindOf(kind) === row && "loop" in d) return d.loop.band;
  return BY_LEARNER.votes.band;
}

function differLines(ov: OrgsView, views: ReadonlyMap<string, KindView>): string[] {
  const found: Array<{ gap: number; text: string }> = [];
  const differs = new Set<string>();
  const compared = new Map<string, number>();
  for (const row of ROW_KINDS) {
    const kv = views.get(row)!;
    for (const [industry, stages] of Object.entries(kv.industries)) {
      const orgs = ov.industryCounts[industry];
      if (!orgs || ov.orgs - orgs <= 0) continue;
      const band = bandOf(row);
      compared.set(industry, Math.max(compared.get(industry) ?? 0, band));
      for (const s of STAGES) {
        const a = stages[s];
        const b = kv.stages[s] - a;
        const gap = Math.abs(a / orgs - b / (ov.orgs - orgs));
        if (gap <= band) continue;
        differs.add(industry);
        found.push({ gap, text: `Where an industry differs: ${keyWords(industry)}, ${kindLabel(row)}, ${STEP[s]} in ${a} of ${orgs} organisations, against ${b} of ${ov.orgs - orgs} for the rest.` });
      }
    }
  }
  const out = found.sort((a, b) => b.gap - a.gap).slice(0, 6).map((f) => f.text);
  for (const [industry, band] of [...compared].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!differs.has(industry)) out.push(`${keyWords(industry)}: no stage differs from the rest by more than ${Math.round(band * 100)} points.`);
  }
  if (!found.length && !compared.size) return [LOOPS_COPY.differsNone];
  const small = Object.entries(ov.industryCounts)
    .filter(([, n]) => n === null)
    .map(([k]) => keyWords(k));
  if (small.length) out.push(`${small.join(", and ")} ${small.length === 1 ? "has" : "have"} fewer than 10 organisations, so ${small.length === 1 ? "it isn't" : "they aren't"} compared.`);
  return out;
}

function coverageRows(ov: OrgsView, meterOn: boolean): { rows: LoopsData["coverage"]; behind: boolean } {
  // Brands the lane visited for the week, opted out and late ones included, against brands listed.
  const short = ov.listed > 0 && ov.visited < ov.listed;
  const fold = ov.foldBehindWeeks;
  const plans = orderPlans(Object.keys(ov.plans)).map((p) => [p, ov.plans[p]!] as [string, number]);
  return {
    behind: short || fold !== null,
    rows: [
      { k: "Brands visited", v: ov.listed > 0 ? `${ov.visited} of ${ov.listed} this week` : `${ov.visited} this week`, amber: short },
      { k: "Oldest week not yet added up", v: fold === null ? "None" : fold >= 10 ? "10 weeks or more behind" : `${plural(fold, "week", "weeks")} behind`, amber: fold !== null },
      { k: "Usage meter", v: meterOn ? "On" : "Off: calls by purpose aren't counted", amber: false },
      { k: "Organisations", v: plans.length ? `${ov.orgs}: ${breakdown(plans)}` : String(ov.orgs), amber: false },
    ],
  };
}

/**
 * The section's numbers and words for one closed week. `imagesCounted`: image style versions are
 * on, so the image pool is counted at all (on unless said). Pure.
 */
export function loopsData(week: LoopsWeekRows, opts: { meterOn: boolean; today: Date; docsUrl: string; imagesCounted?: boolean }): LoopsData {
  const ov = orgsView(week.orgs);
  const views = new Map(ROW_KINDS.map((r) => [r, kindView(week.rows.get(r))]));
  // Organisations by refusal reason from the copy's own row: each once, however many kinds refused it.
  const reasons = ov.refused;
  const cov = coverageRows(ov, opts.meterOn);
  return {
    behind: cov.behind,
    coverage: cov.rows,
    stages: stageRows(ov, views),
    groups: stageGroups(ov, views),
    stalls: stallLines(views),
    waits: waitLines(views),
    reasons: Object.entries(reasons)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || reasonWords(a[0]).localeCompare(reasonWords(b[0])))
      .map(([k, n]) => ({ k: reasonWords(k), v: String(n) })),
    downs: downRows(views),
    stamps: stampRows(views),
    cards: cardLines(views),
    holdback: holdbackLines(views, opts.imagesCounted ?? true),
    industries: industryRows(ov),
    differs: differLines(ov, views),
    notLearning: notLearning(opts.today),
    docsUrl: opts.docsUrl,
    cleanup:
      ov.oldCopy > 0
        ? `Brands still holding a look in the old place: ${ov.oldCopy}. It stays there for switching back: a brand's Forget or Reset clears its own, and there is no step yet to clear the rest.`
        : "Brands still holding a look in the old place: none.",
  };
}
