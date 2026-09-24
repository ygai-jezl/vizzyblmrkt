import { applyOperator, DEFAULT_BRANCH, evaluateCondition, type ConditionContext } from "@/lib/journey/conditions";
import type { ConditionFieldKey } from "@/lib/types/journey";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductContext } from "@/lib/connect/protocol";
import type { Eligibility, LifecycleBranch, LifecycleCondition } from "@/lib/types/lifecycle";

/**
 * Lifecycle condition fields, resolved from what we know about one recipient:
 * the stored profile (built from the product's events) overlaid with the live
 * context the product returned for this run.
 *
 * THREE-STATE: a value we can't know is `undefined`, and an unknown value never
 * matches ANY operator — not even `is_false`. So "unknown" always falls through
 * to a condition's default branch, which authors make the safe lane (e.g. a
 * reminder rather than education about data the user may not have).
 *
 * The exception is `signup.*` (waitlist journeys): those fields are read by the
 * original waitlist engine's own evaluator, so they keep its TWO-STATE logic
 * (a missing value is "hasn't" — `is_false` matches it) and a moved journey
 * routes people exactly as before.
 */

export type FieldValue = string | number | boolean | undefined;

export interface RecipientContext {
  user: Pick<ProductUser, "traits" | "steps" | "milestones" | "consent">;
  catalog: Pick<ConnectionCatalog, "onboardingSteps">;
  /** The product's live context for this run; null when it wasn't available. */
  context: ProductContext | null;
  emailsSent: number;
  enrolledAtMs: number;
  nowMs: number;
  /** Waitlist journeys: the signup, its launch and its rank, for `signup.*` fields. */
  waitlist?: ConditionContext;
}

/** The onboarding checklist: the product's live view if it sent one, else the catalog + stored steps. */
export function checklist(rc: RecipientContext): Array<{ id: string; label: string; done: boolean; url: string | null }> {
  if (rc.context && rc.context.steps.length > 0) {
    return rc.context.steps.map((s) => ({ id: s.id, label: s.label, done: s.done, url: s.url ?? null }));
  }
  return [...rc.catalog.onboardingSteps]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ id: s.id, label: s.label, done: Boolean(rc.user.steps[s.id]), url: s.url ?? null }));
}

export function resolveField(field: string, rc: RecipientContext): FieldValue {
  const dot = field.indexOf(".");
  const family = field.slice(0, dot);
  const key = field.slice(dot + 1);
  switch (family) {
    case "trait": {
      const v = rc.user.traits[key];
      return v === null ? undefined : v;
    }
    case "step": {
      const live = rc.context?.steps.find((s) => s.id === key);
      if (live) return live.done;
      return Boolean(rc.user.steps[key]);
    }
    case "fact": {
      return rc.context?.facts.find((f) => f.id === key)?.value;
    }
    case "milestone":
      return Boolean(rc.user.milestones[key]);
    case "onboarding": {
      const steps = checklist(rc);
      if (steps.length === 0) return undefined;
      const done = steps.filter((s) => s.done).length;
      if (key === "complete") return done === steps.length;
      if (key === "steps_done") return done;
      if (key === "steps_remaining") return steps.length - done;
      return undefined;
    }
    case "consent":
      return key === "basis" ? (rc.context?.consent?.basis ?? rc.user.consent?.basis ?? "none") : undefined;
    case "enrolment":
      if (key === "emails_sent") return rc.emailsSent;
      if (key === "days_since_enrol") return Math.floor((rc.nowMs - rc.enrolledAtMs) / 86_400_000);
      return undefined;
    default:
      return undefined;
  }
}

export function evaluateLifecycleCondition(cond: LifecycleCondition, rc: RecipientContext): boolean {
  if (cond.field.startsWith("signup.")) {
    if (!rc.waitlist) return false;
    const key = cond.field.slice("signup.".length) as ConditionFieldKey;
    return evaluateCondition(
      { field: key, operator: cond.operator, value: cond.value, questionValue: cond.questionValue },
      rc.waitlist,
    );
  }
  const actual = resolveField(cond.field, rc);
  if (actual === undefined) return false; // unknown never matches
  return applyOperator(actual, cond.operator, cond.value);
}

function matches(match: "all" | "any" | undefined, conditions: LifecycleCondition[], rc: RecipientContext): boolean {
  const results = conditions.map((c) => evaluateLifecycleCondition(c, rc));
  return match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** First matching branch id, else "default". */
export function selectLifecycleBranch(branches: LifecycleBranch[] | undefined, rc: RecipientContext): string {
  for (const b of branches ?? []) {
    if (b.conditions.length > 0 && matches(b.match, b.conditions, rc)) return b.id;
  }
  return DEFAULT_BRANCH;
}

/** No conditions = always eligible. */
export function matchesEligibility(e: Eligibility | undefined, rc: RecipientContext): boolean {
  if (!e || e.conditions.length === 0) return true;
  return matches(e.match, e.conditions, rc);
}
