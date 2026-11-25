import { PURPOSE_LABELS, type ResourcePurpose } from "@/lib/plans/resources";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import type { CallSites } from "./callSites";
import { decisionKind, LEARNED_STORES, LOOPS, RULE_DECISIONS, UNMETERED_CALLS, type Decision, type DecisionKind, type LoopKind, type RuleDecision, type UnmeteredCall } from "./registry";

/**
 * The Learning section of docs/ONTOLOGY.md (ADR-0017): every kind in the learning registry
 * (src/lib/loops/registry.ts) under its decision, with its reason, its revisit date and the files
 * that make it, and counts by decision. Pure: the call sites come in from src/lib/loops/callSites.ts.
 * Registry order, apart from gaps, which go by revisit date: the same inputs give the same text.
 */

export type LearningLines = Readonly<Record<LoopKind, Decision>>;

/** The five answers, in the order the section shows them. */
export const DECISION_ORDER: readonly DecisionKind[] = ["learns", "fleet", "own", "gap", "none"];

const DECISION_TITLE: Record<DecisionKind, { title: string; about: string }> = {
  learns: { title: "Learns", about: "it learns for each brand through the loops, behind its own switch." },
  fleet: { title: "Fleet only", about: "it is counted for every brand, and changes only through a pull request the owner merges." },
  own: { title: "Own", about: "it already learns from people, in that store, where the switches for that learning are on." },
  gap: { title: "Gap", about: "it should learn and doesn't yet, with a date to look again." },
  none: { title: "None", about: "it should never learn, and the line says why." },
};

const code = (s: string) => `\`${s}\``;

/** What kind of choice a kind is, in a few words. */
export function kindLabel(kind: LoopKind): string {
  if (kind.startsWith("canvas.")) return "canvas";
  if ((DATA_SIGNAL_RULES as readonly string[]).includes(kind)) return "connector rule";
  if (Object.prototype.hasOwnProperty.call(RULE_DECISIONS, kind)) return `rule, ${RULE_DECISIONS[kind as RuleDecision].label}`;
  if (Object.prototype.hasOwnProperty.call(UNMETERED_CALLS, kind)) return `model call with no meter, ${UNMETERED_CALLS[kind as UnmeteredCall].label}`;
  return `AI purpose, ${PURPOSE_LABELS[kind as ResourcePurpose]}`;
}

/** The line's own words after the kind: where it keeps what it learned, its date, its reason. */
function detail(d: Decision): string {
  if ("loop" in d) {
    const l = d.loop;
    return `, behind ${code(l.switch)}: learns from ${l.learner} in ${l.scopes.map(code).join(", ")}, checked by ${code(l.check)} and guarded by ${code(l.guard)}.`;
  }
  if ("fleet" in d) return `, checked by ${code(d.check)} and guarded by ${code(d.guard)}. ${d.fleet}`;
  if ("own" in d) return `, kept in ${code(d.own)}. ${d.why}`;
  if ("none" in d) return `. ${d.none}`;
  return `, look again by ${d.revisit}. ${d.gap}`;
}

export interface LearningCounts {
  kinds: Record<DecisionKind, number>;
  sites: Record<DecisionKind, number>;
  totalKinds: number;
  totalSites: number;
  /** Call sites under gap and none lines: places that learn nothing from people. */
  notLearning: number;
}

export function learningCounts(sites: CallSites, lines: LearningLines = LOOPS): LearningCounts {
  const zero = (): Record<DecisionKind, number> => ({ learns: 0, fleet: 0, own: 0, gap: 0, none: 0 });
  const kinds = zero();
  const bySite = zero();
  for (const [kind, d] of Object.entries(lines) as Array<[LoopKind, Decision]>) {
    const k = decisionKind(d);
    kinds[k]++;
    bySite[k] += sites[kind]?.length ?? 0;
  }
  const sum = (r: Record<DecisionKind, number>) => DECISION_ORDER.reduce((n, k) => n + r[k], 0);
  return { kinds, sites: bySite, totalKinds: sum(kinds), totalSites: sum(bySite), notLearning: bySite.gap + bySite.none };
}

const revisitOf = (d: Decision) => ("gap" in d ? d.revisit : "");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The section's lines, starting with its heading. */
export function renderLearningSection(sites: CallSites, lines: LearningLines = LOOPS): string[] {
  const c = learningCounts(sites, lines);
  const byDecision = (r: Record<DecisionKind, number>) =>
    `${r.learns} learn, ${r.fleet} fleet only, ${r.own} own, ${r.gap} gap and ${r.none} none`;
  const out: string[] = [
    "## Learning",
    "",
    "Generated from `src/lib/loops/registry.ts` (ADR-0017 in `docs/DECISIONS.md`). Every place YouGrow makes a choice for a brand has one line there: each AI purpose, each canvas Vizzy fills, each connector rule, each other rule and each model call with no meter. " +
      "A new one fails `npm run typecheck` until it has its line (a rule once it is listed in `RULE_DECISIONS`, and a model call with no meter once it is listed in `UNMETERED_CALLS`), and the line gives one of five answers:",
    "",
    ...DECISION_ORDER.map((k) => `- ${DECISION_TITLE[k].title}: ${DECISION_TITLE[k].about}`),
    "",
    "A call site is a file where a kind is made, counted once for each kind: a meter call that names its purpose, a canvas's module, the file that holds a rule, or the file that calls a model with no meter.",
    "",
    `${plural(c.totalKinds, "kind", "kinds")}: ${byDecision(c.kinds)}.`,
    "",
    `${plural(c.totalSites, "call site", "call sites")}: ${byDecision(c.sites)}.`,
    "",
    `Not learning: ${c.notLearning} of ${c.totalSites} call sites, under gap and none lines.`,
    "",
    "### Where own lines keep what they learned",
    "",
    ...Object.entries(LEARNED_STORES).map(([id, where]) => `- ${code(id)}: ${where}`),
    "",
  ];
  const entries = Object.entries(lines) as Array<[LoopKind, Decision]>;
  for (const k of DECISION_ORDER) {
    const here = entries.filter(([, d]) => decisionKind(d) === k);
    // Gaps go by revisit date (a stable sort keeps registry order on the same day).
    if (k === "gap") here.sort(([, a], [, b]) => revisitOf(a).localeCompare(revisitOf(b)));
    out.push(`### ${DECISION_TITLE[k].title}`, "");
    if (!here.length) {
      out.push("No line says this yet.", "");
      continue;
    }
    for (const [kind, d] of here) {
      out.push(`- ${code(kind)} (${kindLabel(kind)})${detail(d)}`);
      const files = sites[kind] ?? [];
      out.push(...(files.length ? files.map((f) => `  - ${code(f)}`) : ["  - No call site in the code."]));
    }
    out.push("");
  }
  return out;
}
