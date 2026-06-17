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

/** trigger = entry; email = a drip send; wait = a delay before the next node. */
export const JourneyNodeType = z.enum(["trigger", "email", "wait"]);
export type JourneyNodeType = z.infer<typeof JourneyNodeType>;

export const JourneyNodeDataSchema = z.object({
  label: z.string().optional(),
  // email node
  subject: z.string().optional(),
  body: z.string().optional(),
  heroImageUrl: z.string().nullable().optional(),
  agentMeta: AgentMetaSchema.optional(),
  // wait node
  waitHours: z.number().int().nonnegative().optional(),
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
