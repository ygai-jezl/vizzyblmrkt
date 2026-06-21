import { z } from "zod";
import { AgentMetaSchema } from "./email";

/**
 * Journey — an automated email sequence for one launch, authored on the Journey
 * Canvas (React Flow). Lives in the tenant-scoped `journeys` collection (one doc
 * per launch). The graph is executed by our in-app engine (queue + worker), NOT
 * by MailChimp Customer Journeys — see src/lib/email/delivery.ts.
 */
export const JourneyStatus = z.enum(["draft", "active", "paused"]);
export type JourneyStatus = z.infer<typeof JourneyStatus>;

/**
 * trigger = entry; email = a drip send; wait = a delay before the next node;
 * condition = a switch that routes the recipient down the first matching branch.
 */
export const JourneyNodeType = z.enum(["trigger", "email", "wait", "condition"]);
export type JourneyNodeType = z.infer<typeof JourneyNodeType>;

/** Comparison operators, grouped by the value type they apply to. */
export const ConditionOperator = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte", // numbers
  "is_true",
  "is_false", // booleans
  "contains", // strings
]);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

/**
 * One rule: read a catalog `field` off the recipient and compare it with
 * `operator`/`value`. See lib/journey/conditions.ts for the field catalog and
 * the evaluator (shared by the worker and the inspector UI).
 */
export const JourneyConditionSchema = z.object({
  field: z.string(), // catalog key, e.g. "referralCount"
  operator: ConditionOperator,
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  questionValue: z.string().optional(), // survey-answer field only
});
export type JourneyCondition = z.infer<typeof JourneyConditionSchema>;

/** One branch of a switch: a stable handle `id` + the rule that selects it. */
export const JourneyBranchSchema = z.object({
  id: z.string(), // edge sourceHandle, e.g. "br_<uuid>"
  label: z.string().optional(),
  condition: JourneyConditionSchema,
});
export type JourneyBranch = z.infer<typeof JourneyBranchSchema>;

/**
 * A/B test on a single email node. The node's base subject/body is always the
 * implicit CONTROL arm; `variants` holds 1–2 challengers (so 2–3 arms total).
 * Hold-out semantics: `splitPercent` is the % of recipients that ENTER the test
 * (split across the challengers); the rest receive the control. Allocation is
 * deterministic per (node, recipient) — see lib/journey/allocation.ts.
 */
export const AbVariantSchema = z.object({
  variantId: z.string(), // "var_<uuid>" — never "control" (that's the base copy)
  subject: z.string(),
  body: z.string(),
  heroImageUrl: z.string().nullable().optional(),
});
export type AbVariant = z.infer<typeof AbVariantSchema>;

export const AbTestStatus = z.enum(["running", "promoted"]);
export type AbTestStatus = z.infer<typeof AbTestStatus>;

export const AbTestSchema = z.object({
  enabled: z.boolean(),
  variants: z.array(AbVariantSchema).min(1).max(2),
  splitPercent: z.number().int().min(1).max(100),
  status: AbTestStatus,
  /** Set once a winner is promoted ("control" or a variant id). */
  winnerVariantId: z.string().nullable().optional(),
  startedAt: z.string().optional(),
});
export type AbTest = z.infer<typeof AbTestSchema>;

export const JourneyNodeDataSchema = z.object({
  label: z.string().optional(),
  // email node
  subject: z.string().optional(),
  body: z.string().optional(),
  heroImageUrl: z.string().nullable().optional(),
  agentMeta: AgentMetaSchema.optional(),
  // email node — optional A/B test (absent = single-email behaviour; base
  // subject/body is the control arm).
  abTest: AbTestSchema.optional(),
  // wait node
  waitHours: z.number().int().nonnegative().optional(),
  // condition node — ordered; first match wins. Recipients matching no branch
  // take the implicit "default" branch (edge sourceHandle === "default").
  branches: z.array(JourneyBranchSchema).max(10).optional(),
});
export type JourneyNodeData = z.infer<typeof JourneyNodeDataSchema>;

export const JourneyNodeSchema = z.object({
  id: z.string(),
  type: JourneyNodeType,
  position: z.object({ x: z.number(), y: z.number() }),
  data: JourneyNodeDataSchema.default({}),
});
export type JourneyNode = z.infer<typeof JourneyNodeSchema>;

export const JourneyEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // Which branch this edge leaves from on a condition node ("default" or a
  // branch id). Null/absent for the single outgoing edge of other node types.
  sourceHandle: z.string().nullable().optional(),
});
export type JourneyEdge = z.infer<typeof JourneyEdgeSchema>;

export const JourneyGraphSchema = z.object({
  nodes: z.array(JourneyNodeSchema).max(200),
  edges: z.array(JourneyEdgeSchema).max(400),
});
export type JourneyGraph = z.infer<typeof JourneyGraphSchema>;

export const JourneySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  status: JourneyStatus,
  graph: JourneyGraphSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Journey = z.infer<typeof JourneySchema>;
