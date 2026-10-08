import { applyOperator, DEFAULT_BRANCH, evaluateCondition, type ConditionContext } from "@/lib/journey/conditions";
import type { ConditionFieldKey } from "@/lib/types/journey";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductContext } from "@/lib/connect/protocol";
import type { Eligibility, LifecycleBranch, LifecycleCondition } from "@/lib/types/lifecycle";
import { entitiesField, type EntityView } from "./entities";
import { daysSince, daysUntil, parseFactDate } from "@/lib/connect/dateFacts";

/**
 * Lifecycle condition fields, resolved from what we know about one recipient:
 * the stored profile (the state the product sends) overlaid with the live
 * context the product returned for this run, when it has a context endpoint.
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
  user: Pick<ProductUser, "traits" | "steps" | "milestones" | "consent" | "facts">;
  catalog: Pick<ConnectionCatalog, "onboardingSteps"> & Partial<Pick<ConnectionCatalog, "facts" | "entityKinds">>;
  /** API v2 entities, when the journey reads them: what this email is about and the ones it counts. */
  entities?: EntityView;
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

/** A fact's value: the live context when it has the fact, else the latest value the product pushed (API v2). */
function factValue(id: string, rc: Pick<RecipientContext, "context" | "user">): FieldValue {
  return rc.context?.facts.find((f) => f.id === id)?.value ?? rc.user.facts?.[id]?.value;
}

/** A date fact as epoch milliseconds — the live value when it's a date, else the stored one; null when neither is. */
export function factDateMs(id: string, rc: Pick<RecipientContext, "context" | "user">): number | null {
  return parseFactDate(rc.context?.facts.find((f) => f.id === id)?.value) ?? parseFactDate(rc.user.facts?.[id]?.value);
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
    case "fact":
      return factValue(key, rc);
    case "days_since":
    case "days_until": {
      // A date fact, as whole days from now. A live value that isn't a date falls back to the one we hold.
      const ms = factDateMs(key, rc);
      if (ms === null) return undefined;
      return family === "days_since" ? daysSince(ms, rc.nowMs) : daysUntil(ms, rc.nowMs);
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
    case "entities":
      return rc.entities ? entitiesField(key, rc.entities.list, rc.catalog) : undefined;
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
