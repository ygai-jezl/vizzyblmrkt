import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";
import type {
  JourneyCondition,
  JourneyBranch,
  ConditionOperator,
} from "@/lib/types/journey";

/**
 * Journey condition catalog + evaluator. ISOMORPHIC — imported by both the
 * server worker (lib/email/delivery.ts) and the client inspector
 * (components/admin/journey/NodeInspector.tsx), so it MUST stay free of
 * server-only imports (no forTenant / firebase-admin / next/*). All the data a
 * condition reads is handed in via ConditionContext, pre-loaded by the caller.
 */

export type ConditionValueType = "number" | "boolean" | "string";

/** Everything a condition can read, pre-loaded by the caller. */
export interface ConditionContext {
  signup: Signup;
  campaign: Campaign;
  rank?: number; // 1-based; from the worker's rankCache
}

export interface ConditionField {
  key: string;
  label: string;
  valueType: ConditionValueType;
  operators: ConditionOperator[];
  /** True for the survey-answer field, which needs a `questionValue` selector. */
  needsQuestion?: boolean;
  /** Pull the comparable value off the context. */
  read: (
    ctx: ConditionContext,
    cond: JourneyCondition,
  ) => number | boolean | string | undefined;
}

const NUM: ConditionOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
const BOOL: ConditionOperator[] = ["is_true", "is_false"];
const STR: ConditionOperator[] = ["eq", "neq", "contains"];

/** The conditions a founder can branch on. Order = display order. */
export const CONDITION_FIELDS: ConditionField[] = [
  {
    key: "madeReferral",
    label: "Made a referral",
    valueType: "boolean",
    operators: BOOL,
    read: (c) => (c.signup.amountReferred ?? 0) > 0,
  },
  {
    key: "referralCount",
    label: "Referral count",
    valueType: "number",
    operators: NUM,
    read: (c) => c.signup.amountReferred ?? 0,
  },
  {
    key: "usedVoiceChat",
    label: "Used the voice chat",
    valueType: "boolean",
    operators: BOOL,
    read: (c) => c.signup.aiConversation?.completed === true,
  },
  {
    key: "rank",
    label: "Waitlist rank",
    valueType: "number",
    operators: NUM,
    read: (c) => c.rank,
  },
  {
    key: "engagementBonus",
    label: "Engagement bonus",
    valueType: "number",
    operators: NUM,
    read: (c) => c.signup.engagementBonus ?? 0,
  },
  {
    key: "surveyAnswer",
    label: "Survey answer",
    valueType: "string",
    operators: STR,
    needsQuestion: true,
    read: (c, cond) =>
      c.signup.answers?.find((a) => a.question_value === cond.questionValue)
        ?.answer_value,
  },
  {
    key: "utmSource",
    label: "UTM source",
    valueType: "string",
    operators: STR,
    read: (c) => c.signup.utm?.source,
  },
  {
    key: "utmMedium",
    label: "UTM medium",
    valueType: "string",
    operators: STR,
    read: (c) => c.signup.utm?.medium,
  },
  {
    key: "utmCampaign",
    label: "UTM campaign",
    valueType: "string",
    operators: STR,
    read: (c) => c.signup.utm?.campaign,
  },
  {
    key: "verified",
    label: "Email verified",
    valueType: "boolean",
    operators: BOOL,
    read: (c) => c.signup.verified === true,
  },
];

export const CONDITION_FIELD_BY_KEY = new Map(
  CONDITION_FIELDS.map((f) => [f.key, f]),
);

/** Human-readable label for an operator (for the inspector dropdown). */
export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  is_true: "is true",
  is_false: "is false",
  contains: "contains",
};

/** The reserved sourceHandle for the implicit else branch of every switch. */
export const DEFAULT_BRANCH = "default";

/** A short human-readable summary of a rule, e.g. "Referral count is at least 5". */
export function describeCondition(cond: JourneyCondition | undefined): string {
  if (!cond) return "any";
  const field = CONDITION_FIELD_BY_KEY.get(cond.field);
  const name = field?.label ?? cond.field;
  const op = OPERATOR_LABELS[cond.operator] ?? cond.operator;
  if (cond.operator === "is_true" || cond.operator === "is_false") {
    return `${name} ${op}`;
  }
  return `${name} ${op} ${String(cond.value ?? "")}`.trim();
}

/** The label to show on a branch (its custom label, else its rule summary). */
export function branchLabel(branch: JourneyBranch): string {
  return branch.label?.trim() || describeCondition(branch.condition);
}

/**
 * Evaluate one rule against the context. Unknown field, or a value that can't be
 * compared, evaluates to false — except `is_false`, which is true for
 * missing/falsey data ("hasn't done X").
 */
export function evaluateCondition(
  cond: JourneyCondition,
  ctx: ConditionContext,
): boolean {
  const field = CONDITION_FIELD_BY_KEY.get(cond.field);
  if (!field) return false;
  const actual = field.read(ctx, cond);

  switch (cond.operator) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual !== true; // missing/false ⇒ "hasn't done X" ⇒ true
    case "eq":
      return looseEq(actual, cond.value);
    case "neq":
      return !looseEq(actual, cond.value);
    case "contains":
      return (
        typeof actual === "string" &&
        typeof cond.value === "string" &&
        actual.toLowerCase().includes(cond.value.toLowerCase())
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof cond.value !== "number")
        return false;
      if (cond.operator === "gt") return actual > cond.value;
      if (cond.operator === "gte") return actual >= cond.value;
      if (cond.operator === "lt") return actual < cond.value;
      return actual <= cond.value;
    }
    default:
      return false;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return String(a ?? "") === String(b ?? "");
}

/**
 * Switch evaluation: walk branches in order, return the handle of the first one
 * whose rule matches; fall back to the "default" branch if none match. The
 * returned string is the edge `sourceHandle` to follow.
 */
export function selectBranch(
  branches: JourneyBranch[] | undefined,
  ctx: ConditionContext,
): string {
  for (const b of branches ?? []) {
    if (evaluateCondition(b.condition, ctx)) return b.id;
  }
  return DEFAULT_BRANCH;
}
