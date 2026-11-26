import { z } from "zod";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { FACT_KINDS, type FactKind } from "@/lib/onboarding/choices";
import {
  ActionCardSchema,
  GOAL_METRICS,
  NEXT_ACTION_LIMITS,
  STEP_KEYS,
  isActionId,
  stepActionKey,
  type ActionCard,
  type ActionId,
  type FallbackReason,
  type GoalMetric,
  type Step,
} from "@/lib/types/nextAction";
import { actionSpec } from "./actions";

/**
 * Turning the model's answer into a card, or saying why it can't be one (ADR-0022). Pure, and fails
 * closed: any step that names an action off the brand's list, a card that fails the schema, or a
 * line that breaks the writing rules gives no card, and Home shows the steps list instead.
 *
 * Two things are left out rather than failed: a step whose action the founder dismissed in the last
 * 30 days (never offered again, whatever the model says), and, on Show another, a step the card
 * just replaced, while others remain.
 */

const L = NEXT_ACTION_LIMITS;

/** What the check knows besides the model's answer. */
export interface CheckContext {
  /** The ids this brand and person may use now (actions.ts allowedActions). */
  allowed: ReadonlySet<ActionId>;
  /** Step keys (stepActionKey) the founder dismissed in the last QUIET_DAYS. */
  quiet: ReadonlySet<string>;
  /** A step was done since the card before, so a Note may say what was finished. */
  doneSinceLast: boolean;
  /** On Show another: the step keys of the card being replaced. */
  replaced?: ReadonlySet<string>;
}

export type CardCheck = { ok: true; card: ActionCard } | { ok: false; reason: FallbackReason };

/** The model's answer as asked for: lenient per field, so the checks below decide. */
const RawStep = z.object({
  title: z.string().catch(""),
  why: z.string().catch(""),
  action: z.string().catch("none").default("none"),
  button: z.string().catch("").default(""),
  question: z.string().catch("").default(""),
  choices: z
    .array(z.object({ label: z.string().catch(""), fact: z.string().catch("").default("") }))
    .catch([])
    .default([]),
  factKind: z.string().catch("none").default("none"),
  goalMetric: z.string().catch("none").default("none"),
  goalTarget: z.number().catch(0).default(0),
});
const RawCard = z.object({ steps: z.array(z.unknown()), note: z.string().catch("").default("") });

/** One line: every run of spacing becomes a space; a dash used as punctuation becomes a comma. */
export function tidyLine(text: string): string {
  return text
    .replace(/[\s\u0085]+/g, " ")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/(?<=\S) - (?=\S)/g, ", ")
    .trim();
}

const NONE = new Set(["", "none", "null"]);

/** A link, a web address or a path in what should be plain words. */
const LINK = /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|app|dev|xyz|uk|eu)\b|(?:^|\s)\/[a-z]/i;

/** Every line of words on a card, for the writing rules. */
export function cardLines(card: ActionCard): string[] {
  return [
    ...card.steps.flatMap((s) => [
      s.title,
      s.why,
      ...(s.button ? [s.button] : []),
      ...(s.choices ? [s.choices.question, ...s.choices.options.flatMap((o) => [o.label, ...(o.fact ? [o.fact] : [])])] : []),
    ]),
    ...(card.note ? [card.note.text] : []),
  ];
}

/** What breaks the writing rules on a card: dashes as punctuation, an AI tell, or a link. Empty when fine. */
export function writingProblems(card: ActionCard): string[] {
  return cardLines(card).flatMap((line) => [...dashesIn(line), ...aiTellsIn(line), ...(LINK.test(line) ? [`a link: ${line.slice(0, 40)}`] : [])]);
}

type Candidate = Omit<Step, "key">;

/** One step of the model's answer, or the reason the card fails. */
function stepOf(raw: unknown, c: CheckContext): Candidate | { fail: FallbackReason } {
  const r = RawStep.safeParse(raw);
  if (!r.success) return { fail: "schema" };
  const s = r.data;
  const base = { type: "Step" as const, title: tidyLine(s.title), why: tidyLine(s.why) };
  const action = s.action.trim();
  if (!NONE.has(action.toLowerCase())) {
    // Never an id off the brand's list, and never a URL or a path in its place.
    if (!isActionId(action) || !c.allowed.has(action)) return { fail: "allowlist" };
    const words = tidyLine(s.button);
    const button = words && words.length <= L.BUTTON ? words : actionSpec(action).label;
    return { ...base, action, button, choices: null, progress: null };
  }
  const answers = s.choices.map((o) => ({ label: tidyLine(o.label), fact: tidyLine(o.fact) })).filter((o) => o.label);
  if (tidyLine(s.question) && answers.length) {
    const kind = (FACT_KINDS as readonly string[]).includes(s.factKind) ? (s.factKind as FactKind) : null;
    return {
      ...base,
      action: null,
      button: null,
      choices: { type: "ChoiceChips", question: tidyLine(s.question), options: answers.map((o) => ({ label: o.label, fact: kind ? o.fact : null })), fact: kind },
      progress: null,
    };
  }
  if ((GOAL_METRICS as readonly string[]).includes(s.goalMetric) && Number.isInteger(s.goalTarget) && s.goalTarget > 0) {
    return { ...base, action: null, button: null, choices: null, progress: { type: "Progress", metric: s.goalMetric as GoalMetric, target: s.goalTarget } };
  }
  return { fail: "schema" };
}

/**
 * The card from the model's answer (parsed JSON), checked: the schema (1 to 3 steps, each doing one
 * thing), the brand's allowlist, what the founder dismissed, and the writing rules.
 */
export function cardFromModel(raw: unknown, c: CheckContext): CardCheck {
  const r = RawCard.safeParse(raw);
  if (!r.success) return { ok: false, reason: "schema" };
  if (r.data.steps.length === 0) return { ok: false, reason: "empty" };
  if (r.data.steps.length > L.MAX_STEPS) return { ok: false, reason: "schema" };
  const candidates: Candidate[] = [];
  for (const raw of r.data.steps) {
    const s = stepOf(raw, c);
    if ("fail" in s) return { ok: false, reason: s.fail };
    candidates.push(s);
  }
  // Never offered again: what the founder dismissed. On Show another, something new where possible.
  const fresh = candidates.filter((s) => !c.quiet.has(stepActionKey(s)));
  const replaced = c.replaced;
  const other = replaced ? fresh.filter((s) => !replaced.has(stepActionKey(s))) : fresh;
  const kept = other.length ? other : fresh;
  if (kept.length === 0) return { ok: false, reason: "empty" };
  const note = tidyLine(r.data.note);
  const card = {
    type: "ActionCard" as const,
    v: 1 as const,
    steps: kept.map((s, i) => ({ ...s, key: STEP_KEYS[i]! })),
    note: note && c.doneSinceLast ? { type: "Note" as const, tone: "done" as const, text: note } : null,
  };
  const parsed = ActionCardSchema.safeParse(card);
  if (!parsed.success) return { ok: false, reason: "schema" };
  if (writingProblems(parsed.data).length) return { ok: false, reason: "writing" };
  return { ok: true, card: parsed.data };
}

/**
 * A card kept earlier, checked again before it is drawn: the schema, and every action still on the
 * brand's list now (a switch or a role may have changed since). Null when it no longer passes.
 */
export function recheckCard(card: unknown, allowed: ReadonlySet<ActionId>): ActionCard | null {
  const parsed = ActionCardSchema.safeParse(card);
  if (!parsed.success) return null;
  if (parsed.data.steps.some((s) => s.action !== null && !allowed.has(s.action))) return null;
  return parsed.data;
}
