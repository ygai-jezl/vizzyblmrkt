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

export const JourneyNodeDataSchema = z.object({
  label: z.string().optional(),
  // email node
  subject: z.string().optional(),
  body: z.string().optional(),
  heroImageUrl: z.string().nullable().optional(),
  agentMeta: AgentMetaSchema.optional(),
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
