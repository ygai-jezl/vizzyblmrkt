import { LOOP_RULES } from "./registry";
import { STAGES, STUCK_STEPS, type Stage, type StuckStep } from "./stages";

/**
 * The counts across brands as the people who run the copy may see them (learning loops step 5,
 * 4.7 of the plan for steps 4 and 5): one `fleet_cells` row read into numbers, with the floors
 * applied here, once, so every screen and reader shows the same. Pure.
 *
 * - Numbers of things (outputs made, kept, liked or declined, declines and thumbs by reason,
 *   unstamped saves, coverage and unused), shares and industry splits show only from
 *   LOOP_RULES.cellOrgs (10) contributing organisations; below that they are null, and a screen
 *   says "fewer than 10".
 * - Counts of organisations show below 10 in four places, to the people who run the copy only
 *   (the owner's answer to question 4): per step, stuck per plan, by refusal reason and with a Go
 *   back card. They never set defaults. Every other count of organisations (the wait for a check,
 *   and industries) keeps the floor.
 * - Numbers of things are rounded to 2 significant figures.
 */

/** Where counts of organisations show below the floor, to the people who run the copy only. They never set defaults. */
export const ORG_COUNTS_BELOW_FLOOR = ["stages", "stuck", "refused", "cards"] as const;

/** Whether numbers of things, shares and splits show for this many contributing organisations. */
export const showsThings = (orgs: number): boolean => orgs >= LOOP_RULES.cellOrgs;

/** A number of things as shown: 2 significant figures (1,234 reads 1,200). */
export function roundTwo(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const step = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.abs(n))) - 1));
  return Math.round(n / step) * step;
}

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const at = (t: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, k) => (isObj(node) ? node[k] : undefined), t);
type Counts = Record<string, number>;

/** A map of amounts, its non amounts left out. */
function counts(t: unknown, round = false): Counts {
  const out: Counts = {};
  if (isObj(t)) for (const [k, v] of Object.entries(t)) if (num(v) > 0) out[k] = round ? roundTwo(num(v)) : num(v);
  return out;
}

/** One plan's organisations at each step, how many are stuck at Stamped and Signalled, and whether the whole plan is. */
export interface PlanStall {
  reached: Record<Stage, number>;
  stuck: Record<StuckStep, number>;
  /** Stuck organisations' most common refusal reason, by step. */
  topReason: Partial<Record<StuckStep, string>>;
  /** Stuck organisations by refusal reason, by step (shown below 10, as stuck is). */
  why: Record<StuckStep, Counts>;
  /** Steps where every organisation on the plan that reached it is stuck there and none went further: the shape of a learner the plan blocks. */
  amber: StuckStep[];
}

/** What the people who run the copy see of one kind of choice in one closed week. */
export interface KindView {
  /** Organisations counted in the row. */
  orgs: number;
  /** Organisations that reached each step, through the furthest (shown below 10). */
  stages: Record<Stage, number>;
  /** By plan (shown below 10). */
  plans: Record<string, PlanStall>;
  /** Organisations by learner refusal reason (shown below 10). */
  refused: Counts;
  /** Organisations with a Go back card (shown below 10). */
  cardOrgs: number;
  /** Organisations with a learned look and no check yet, and the longest wait in whole months (24 or more reads 24); null below 10 organisations. */
  waiting: { orgs: number; longestMonths: number | null } | null;
  /** Numbers of things, rounded; null below 10 organisations. */
  things: KindThings | null;
  /** Organisations per step by industry, only for an industry where it and the rest both have 10 or more. */
  industries: Record<string, Record<Stage, number>>;
}

export interface KindThings {
  /** By arm, then signal. */
  out: Record<string, Counts>;
  /** The image pool: by style, then arm, then made, voted, liked and remade. */
  scope: Record<string, Record<string, Counts>>;
  own: Counts;
  /** Thumbs up and down by reason. */
  liked: Counts;
  disliked: Counts;
  /** Declines by why. */
  declined: Counts;
  /** Saves with no stamp, by reason (`stamp_lost` included). */
  unstamped: Counts;
  /** Learning cards by signal: proposed, expired, acted, declined and ignored. */
  cards: Counts;
  /** Stamped saves against all saves; null when none was saved. */
  coverage: number | null;
  /** Made two weeks before with nothing kept, edited or declined since. */
  unused: number;
}

const byStage = (f: (s: Stage) => number): Record<Stage, number> => Object.fromEntries(STAGES.map((s) => [s, f(s)])) as Record<Stage, number>;

/** One `fh:<kind>` row's counts (its `n`) as they may be shown. */
export function kindView(n: unknown): KindView {
  const orgs = num(at(n, "orgs"));
  const stageByPlan = (s: Stage) => counts(at(n, "st", s, "p"));
  const stages = byStage((s) => Object.values(stageByPlan(s)).reduce((a, b) => a + b, 0));

  const planIds = new Set<string>();
  for (const s of STAGES) for (const p of Object.keys(stageByPlan(s))) planIds.add(p);
  for (const step of STUCK_STEPS) for (const p of Object.keys(counts(at(n, "stuck", step, "p")))) planIds.add(p);
  const plans: Record<string, PlanStall> = {};
  for (const p of [...planIds].sort()) {
    const reached = byStage((s) => num(at(n, "st", s, "p", p)));
    const stuck = Object.fromEntries(STUCK_STEPS.map((step) => [step, num(at(n, "stuck", step, "p", p))])) as Record<StuckStep, number>;
    const topReason: Partial<Record<StuckStep, string>> = {};
    const why = Object.fromEntries(STUCK_STEPS.map((step) => [step, counts(at(n, "stuck", step, "why", p))])) as Record<StuckStep, Counts>;
    const amber: StuckStep[] = [];
    for (const step of STUCK_STEPS) {
      const top = Object.entries(why[step]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (top) topReason[step] = top[0];
      const next = STAGES[STAGES.indexOf(step) + 1]!;
      if (stuck[step] > 0 && stuck[step] >= reached[step] && reached[next] === 0) amber.push(step);
    }
    plans[p] = { reached, stuck, topReason, why, amber };
  }

  const shown = showsThings(orgs);
  const waitOrgs = num(at(n, "wait", "orgs"));
  const months = Object.keys(counts(at(n, "wait", "m")))
    .map((k) => Number(/^m(\d{1,2})$/.exec(k)?.[1]))
    .filter(Number.isFinite);
  const waiting = shown ? { orgs: waitOrgs, longestMonths: months.length ? Math.max(...months) : null } : null;

  let things: KindThings | null = null;
  if (shown) {
    const out: Record<string, Counts> = {};
    if (isObj(at(n, "out"))) for (const [arm, sig] of Object.entries(at(n, "out") as Tree)) out[arm] = counts(sig, true);
    const scope: Record<string, Record<string, Counts>> = {};
    if (isObj(at(n, "scope"))) {
      for (const [style, byArm] of Object.entries(at(n, "scope") as Tree)) {
        if (!isObj(byArm)) continue;
        scope[style] = Object.fromEntries(Object.entries(byArm).map(([arm, sig]) => [arm, counts(sig, true)]));
      }
    }
    const stamped = num(at(n, "cov", "stamped"));
    const all = stamped + num(at(n, "cov", "unstamped")) + num(at(n, "cov", "lost"));
    things = {
      out,
      scope,
      own: counts(at(n, "own"), true),
      liked: counts(at(n, "why", "liked"), true),
      disliked: counts(at(n, "why", "disliked"), true),
      declined: counts(at(n, "declined"), true),
      unstamped: counts(at(n, "u"), true),
      cards: Object.fromEntries(Object.entries(counts(at(n, "cards"), true)).filter(([k]) => k !== "orgs")),
      coverage: all > 0 ? stamped / all : null,
      unused: roundTwo(num(at(n, "unused"))),
    };
  }

  // Industries: an industry shows only where it and the rest both reach the floor.
  const industries: Record<string, Record<Stage, number>> = {};
  const inIndustry = counts(at(n, "st", "stamped", "i"));
  for (const [industry, k] of Object.entries(inIndustry)) {
    if (showsThings(k) && showsThings(stages.stamped - k)) industries[industry] = byStage((s) => num(at(n, "st", s, "i", industry)));
  }

  return { orgs, stages, plans, refused: counts(at(n, "refused")), cardOrgs: num(at(n, "cards", "orgs")), waiting, things, industries };
}

/** What the people who run the copy see of the copy's own row (`fh:_orgs`) in one closed week. */
export interface OrgsView {
  /** Organisations that sent a heartbeat (Declared), and by plan (shown below 10). */
  orgs: number;
  plans: Counts;
  /** By industry, only where an industry and the rest both have 10 or more: the industries that can be compared. */
  industries: Counts;
  /** Every industry's organisations, from 10 of them; null below 10 (a screen says "fewer than 10"). */
  industryCounts: Record<string, number | null>;
  /** Brands that reported the week against brands listed, and reports dropped as late. */
  reported: number;
  listed: number;
  late: number;
  /** Brands still holding a look on the brand record. */
  oldCopy: number;
  /** How many weeks behind the furthest behind fold was (10 or more reads 10), or null when none was. */
  foldBehindWeeks: number | null;
}

/** The `fh:_orgs` row's counts as they may be shown. */
export function orgsView(n: unknown): OrgsView {
  const orgs = num(at(n, "orgs"));
  const industries: Counts = {};
  const industryCounts: Record<string, number | null> = {};
  for (const [i, k] of Object.entries(counts(at(n, "i")))) {
    industryCounts[i] = showsThings(k) ? k : null;
    if (showsThings(k) && showsThings(orgs - k)) industries[i] = k;
  }
  const behind = Object.keys(counts(at(n, "foldBehind")))
    .map((k) => Number(/^w(\d{1,2})$/.exec(k)?.[1]))
    .filter(Number.isFinite);
  return {
    orgs,
    plans: counts(at(n, "p")),
    industries,
    industryCounts,
    reported: num(at(n, "reported")),
    listed: num(at(n, "listed")),
    late: num(at(n, "late")),
    oldCopy: num(at(n, "oldCopy")),
    foldBehindWeeks: behind.length ? Math.max(...behind) : null,
  };
}

/** Made per ontology type (`fh:_types`), or calls per purpose (`fh:_calls`), for one type or purpose: its organisations and, from 10 of them, its rounded count. */
export function namedCount(n: unknown, row: "types" | "calls", name: string): { orgs: number; count: number | null } {
  const orgs = num(at(n, "orgs", name));
  const raw = num(at(n, row === "types" ? "made" : "calls", name));
  return { orgs, count: showsThings(orgs) ? roundTwo(raw) : null };
}
