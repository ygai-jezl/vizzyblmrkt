import { z } from "zod";

/**
 * A ContentPlan — the "Create" pillar's saved, recallable workflow. An operator
 * gives strategic guidance (objective / spark / topics / hub + spoke channels) and
 * an Architect agent builds a NODE GRAPH on a canvas: a Hub (newsletter/blog), the
 * Pre-Hub + Post-Hub promo blocks, and a channel-native Spoke per selected channel.
 * Each node fills progressively (its own short request) so the canvas builds live
 * and the plan is resumable from Firestore.
 *
 * Stored at workspaces/{workspaceId}/content_plans/{id} in the tenant's REGIONAL
 * DB (same pattern + tenant boundary as templates / idea_items — callers MUST
 * `verifyWorkspace(ctx, workspaceId)` first; every doc also stamps tenantId +
 * workspaceId as defence-in-depth).
 *
 * DISTRIBUTE-SHAPED: every ContentNode carries `{channel, body, scheduledAt}` so the
 * later Distribute pillar maps a node straight to a per-channel job (mirroring the
 * EmailJob / Broadcast shape) without a translation layer.
 */

export const ContentPlanStatus = z.enum([
  "draft", // intake captured, no graph yet
  "generating", // architect/nodes being filled
  "ready", // graph built + nodes filled
  "scheduled", // handed to Distribute
  "archived",
]);
export type ContentPlanStatus = z.infer<typeof ContentPlanStatus>;

export const ContentObjective = z.enum([
  "newsletter_signups",
  "product_launch",
  "brand_visibility",
]);
export type ContentObjective = z.infer<typeof ContentObjective>;

/** A node's role in the hub-and-spoke topology. */
export const ContentNodeType = z.enum(["promo_pre", "hub", "promo_post", "spoke"]);
export type ContentNodeType = z.infer<typeof ContentNodeType>;

/** Per-node generation lifecycle (drives the canvas status chip). */
export const ContentNodeStatus = z.enum([
  "empty", // skeleton placed, not generated
  "generating",
  "generated",
  "error",
  "approved", // operator-approved final copy
]);
export type ContentNodeStatus = z.infer<typeof ContentNodeStatus>;

// Caps keep a saved graph bounded (anti-poisoning): a plan can't carry a runaway
// node count or megabyte bodies. Generous vs the real topology (hub + 2 promos +
// up to ~6 spokes ≈ 9 nodes) but a hard ceiling.
const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_BODY_CHARS = 20000;

export const ContentNodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: ContentNodeType,
  /** Destination channel id (src/lib/content/channels.ts). */
  channel: z.string().min(1).max(40),
  /** Channel-native format id (src/lib/content/channels.ts). */
  format: z.string().max(40).nullable().optional(),
  /** Modular ROLE id (src/lib/content/blocks.ts). */
  blockType: z.string().max(40).nullable().optional(),
  /** Human label shown on the node ("Hub: Newsletter", "Pre-Hub Promo (X)"). */
  role: z.string().min(1).max(120),
  position: z.object({ x: z.number(), y: z.number() }),
  /** A workspace Template skeleton this node draws from (if one was matched). */
  templateId: z.string().max(64).nullable().optional(),
  /** Per-node generation instruction the Architect wrote. */
  brief: z.string().max(2000).nullable().optional(),
  /** FINAL filled copy — "" until generated. This IS the Distribute payload body. */
  body: z.string().max(MAX_BODY_CHARS).default(""),
  /** Filled {{token}} values, reconciled against the body. */
  placeholderValues: z.record(z.string(), z.string()).default({}),
  status: ContentNodeStatus.default("empty"),
  /** Distribute fills this (ISO); null until scheduled. */
  scheduledAt: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
});
export type ContentNode = z.infer<typeof ContentNodeSchema>;

export const ContentEdgeSchema = z.object({
  id: z.string().min(1).max(96),
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
});
export type ContentEdge = z.infer<typeof ContentEdgeSchema>;

export const ContentGraphSchema = z.object({
  nodes: z.array(ContentNodeSchema).max(MAX_NODES).default([]),
  edges: z.array(ContentEdgeSchema).max(MAX_EDGES).default([]),
});
export type ContentGraph = z.infer<typeof ContentGraphSchema>;

export const ContentStrategySchema = z.object({
  objective: ContentObjective,
  /** The hub's public URL, substituted into promo CTAs as {{hub_url}}. */
  hubUrl: z.string().max(2000).nullable().optional(),
  /** Manual subscriber count, substituted as {{subscriber_count}}. */
  subscriberCount: z.number().int().nonnegative().nullable().optional(),
});
export type ContentStrategy = z.infer<typeof ContentStrategySchema>;

export const ContentScopeSchema = z.object({
  /** Content Matrix topic ids to ground + organise around. */
  topics: z.array(z.string().max(60)).max(26).default([]),
  /** The angle / thesis the operator wants this workflow to make. */
  spark: z.string().max(4000).default(""),
});
export type ContentScope = z.infer<typeof ContentScopeSchema>;

export const ContentKnowledgeSchema = z.object({
  /** "global" = all workspace knowledge; "scoped" = pre-filter RAG by the scope topics. */
  groundingScope: z.enum(["global", "scoped"]).default("global"),
  /** Pasted proof / case-study text the operator wants woven in (untrusted DATA). */
  proofAssets: z.array(z.string().max(4000)).max(10).default([]),
});
export type ContentKnowledge = z.infer<typeof ContentKnowledgeSchema>;

export const ContentTopologySchema = z.object({
  hubChannel: z.enum(["newsletter", "blog"]).default("newsletter"),
  /** Social/channel ids to generate spokes for. */
  spokeChannels: z.array(z.string().max(40)).max(8).default([]),
});
export type ContentTopology = z.infer<typeof ContentTopologySchema>;

export const ContentPlanSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(200),
  status: ContentPlanStatus.default("draft"),
  strategy: ContentStrategySchema,
  scope: ContentScopeSchema,
  knowledge: ContentKnowledgeSchema,
  topology: ContentTopologySchema,
  graph: ContentGraphSchema.default({ nodes: [], edges: [] }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

export const CONTENT_PLAN_LIMITS = {
  MAX_NODES,
  MAX_EDGES,
  MAX_BODY_CHARS,
} as const;
