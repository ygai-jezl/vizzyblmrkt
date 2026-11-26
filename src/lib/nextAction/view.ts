import type { GrowthSignals } from "@/lib/nav/growth";
import type { GoalMetric, NextActionRecord, Progress, StepKey, StepState } from "@/lib/types/nextAction";
import { allowedActions, resolveAction, type ActionEnv } from "./actions";
import { recheckCard } from "./card";

/**
 * The card as Home draws it (ADR-0020): each button resolved on the server to a path from the list
 * or one of our prompts, a goal's count read from the brand's data (a goal reached is done), and
 * dismissed or replaced steps left out. Pure, and client safe in its output: the view holds no ids from the allowlist's inside.
 */

export interface CardStepView {
  key: StepKey;
  /** 1, 2, 3 in the order shown. */
  n: number;
  title: string;
  why: string;
  state: Extract<StepState, "open" | "done" | "answered">;
  button: { label: string; href: string | null; prompt: string | null } | null;
  question: { label: string; options: string[]; picked: string | null; keeps: boolean } | null;
  goal: { now: number | null; target: number } | null;
}

export interface CardView {
  cardId: string;
  steps: CardStepView[];
  /** What the team just finished, and whether that was today (UTC). */
  note: { text: string; today: boolean } | null;
  done: number;
  total: number;
}

type Counts = Pick<GrowthSignals, "signups" | "postsScheduled" | "newslettersSent">;

function countOf(metric: GoalMetric, s: Counts): number | null {
  if (metric === "signups") return s.signups;
  if (metric === "posts") return s.postsScheduled;
  return s.newslettersSent;
}

/** Whether the brand's count got to a goal's target: the goal is done, with nothing to press. */
export function goalReached(goal: Pick<Progress, "metric" | "target">, s: Counts): boolean {
  const now = countOf(goal.metric, s);
  return now !== null && now >= goal.target;
}

/**
 * The card to draw, or null when there is none to draw: no card, a fallback, a card that no longer
 * passes the checks (an action off the brand's list now), or every step dismissed.
 */
export function cardView(
  record: NextActionRecord | null,
  env: ActionEnv,
  signals: Pick<GrowthSignals, "signups" | "postsScheduled" | "newslettersSent">,
  nowMs: number,
): CardView | null {
  if (!record || record.status !== "card" || !record.cardId) return null;
  const card = recheckCard(record.card, new Set(allowedActions(env)));
  if (!card) return null;
  const stateOf = new Map(record.steps.map((s) => [s.key, s.state]));
  const shown = card.steps.filter((s) => {
    const st = stateOf.get(s.key);
    return st === "open" || st === "done" || st === "answered";
  });
  if (!shown.length) return null;
  const steps: CardStepView[] = shown.map((s, i) => {
    const kept = stateOf.get(s.key) as CardStepView["state"];
    const state = kept === "open" && s.progress && goalReached(s.progress, signals) ? "done" : kept;
    const resolved = s.action ? resolveAction(s.action, env) : null;
    const picked = record.outcomes.find((o) => o.cardId === record.cardId && o.step === s.key && o.state === "answered")?.answer ?? null;
    return {
      key: s.key,
      n: i + 1,
      title: s.title,
      why: s.why,
      state,
      button:
        s.button && resolved
          ? { label: s.button, href: resolved.kind === "page" ? resolved.href : null, prompt: resolved.kind === "ask" ? resolved.prompt : null }
          : null,
      question: s.choices ? { label: s.choices.question, options: s.choices.options.map((o) => o.label), picked, keeps: s.choices.fact !== null } : null,
      goal: s.progress ? { now: countOf(s.progress.metric, signals), target: s.progress.target } : null,
    };
  });
  // The note is about the card before this one: when its newest step was done.
  const doneAt = record.outcomes.find((o) => o.cardId !== record.cardId && (o.state === "done" || o.state === "answered"))?.at;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return {
    cardId: record.cardId,
    steps,
    note: card.note ? { text: card.note.text, today: !!doneAt && doneAt.slice(0, 10) === today } : null,
    done: steps.filter((s) => s.state !== "open").length,
    total: steps.length,
  };
}
