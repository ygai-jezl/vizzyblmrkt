import { z } from "zod";
import { EmailLayoutSchema, MAX_EMAIL_BLOCKS } from "@/lib/types/emailLayout";

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
  "email_sequence",
]);
export type ContentObjective = z.infer<typeof ContentObjective>;

/**
 * The 7 email-sequence archetypes (only meaningful when objective === "email_sequence").
 * Each maps to a canvas blueprint + a copy framework — see src/lib/content/create/
 * sequenceBlueprints.ts. `welcome` is the Context-Mapping-Matrix "new_signup" scenario.
 */
export const SequenceType = z.enum([
  "welcome",
  "lead_nurture",
  "cold_outbound",
  "abandoned_cart",
  "post_purchase",
  "upsell",
  "win_back",
]);
export type SequenceType = z.infer<typeof SequenceType>;

/**
 * A node's role. The hub-and-spoke objectives use promo_pre/hub/promo_post/spoke; the
 * email_sequence objective uses trigger/email/wait/condition (a linear drip with
 * branch splits). All additive so pre-existing saved plans still parse.
 */
export const ContentNodeType = z.enum([
  "promo_pre",
  "hub",
  "promo_post",
  "spoke",
  "trigger",
  "email",
  "wait",
  "condition",
]);
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

/** Per-node DISTRIBUTION lifecycle (Distribute pillar). Kept SEPARATE from `status` so it
 *  never perturbs generation gating (hubApproved / progress counts / schedulable checks).
 *  Null until the node is scheduled. Written ONLY by the schedule route + Distribute worker
 *  (updateContentPlanNode), never by canvas editing. */
export const ContentDistributionStatus = z.enum([
  "scheduled", // queued on campaign_scheduled_posts
  "posting", // worker claimed it (in-flight)
  "posted", // published successfully (terminal)
  "failed", // terminally failed to post (parked / retries exhausted)
]);
export type ContentDistributionStatus = z.infer<typeof ContentDistributionStatus>;

// Caps keep a saved graph bounded (anti-poisoning): a plan can't carry a runaway
// node count or megabyte bodies. The spider-web can reach 5 core angles × up to 8
// channels = 40 spokes + hub + 2 promos = 43; 60 leaves room for a few manual adds.
const MAX_NODES = 60;
const MAX_EDGES = 80;
const MAX_BODY_CHARS = 20000;
// eBook hub caps. A whole book lives in ONE plan doc (chapters copied onto the hub
// node at finalize), so bound it well under Firestore's 1MB doc limit: 16 chapters ×
// 16k HTML chars ≈ 256KB of prose + a few dozen image REFS (filenames, not bytes).
const MAX_CHAPTERS = 16;
const MAX_IMAGES_PER_CHAPTER = 8;
const MAX_CHAPTER_CHARS = 16000;

/** Operator-facing eBook image aspect ratios (see src/lib/content/create/ebook.ts). */
export const EbookAspect = z.enum(["1:1", "1:4"]);
export type EbookAspect = z.infer<typeof EbookAspect>;

/**
 * An image SLOT inside an eBook chapter. Starts as a `placeholder` the model inserts
 * where an illustration belongs (anchored in bodyHtml via `<div data-ebook-image="id">`);
 * becomes `generated` once an on-brand image is rendered/uploaded. Only the workspace-
 * asset FILENAME is stored (served via the authenticated /asset proxy) — never bytes.
 */
export const EbookImageSlotSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["placeholder", "generated"]).default("placeholder"),
  imageAssetRef: z.string().max(2000).nullable().optional(),
  aspect: EbookAspect.default("1:1"),
  /** Rendered width as a % of the reading column — the operator resize value. */
  width: z.number().int().min(20).max(100).default(100),
  /** Horizontal placement of the image in the page. */
  align: z.enum(["left", "center", "right"]).default("center"),
  /** When true, chapter text wraps around the image (float); else it's a block on its own line. */
  wrap: z.boolean().default(false),
  /** One-line brief the model wrote for this illustration; seeds "Create image". */
  contextPrompt: z.string().max(1000).default(""),
  /** The expanded image prompt actually rendered (transparency / re-roll reference). */
  imagePrompt: z.string().max(1000).nullable().optional(),
});
export type EbookImageSlot = z.infer<typeof EbookImageSlotSchema>;

/** One eBook chapter. `bodyHtml` is sanitized rich text ("" until generated). */
export const EbookChapterSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  /** ToC one-liner — what this chapter covers. */
  summary: z.string().max(1000).default(""),
  bodyHtml: z.string().max(MAX_CHAPTER_CHARS).default(""),
  status: z.enum(["planned", "generating", "generated", "confirmed"]).default("planned"),
  images: z.array(EbookImageSlotSchema).max(MAX_IMAGES_PER_CHAPTER).default([]),
});
export type EbookChapter = z.infer<typeof EbookChapterSchema>;

/**
 * The full eBook document. Lives on `ContentPlan.ebookDraft` while authoring in the
 * studio, then is copied onto the hub `ContentNode.ebook` when the plan is finalized
 * onto the canvas. Additive + nullable everywhere so non-eBook plans are unaffected.
 */
export const EbookDocSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).default(""),
  /** The industry framing captured in the Scope step (grounds ToC + chapters). */
  industryLens: z.string().max(500).default(""),
  chapters: z.array(EbookChapterSchema).max(MAX_CHAPTERS).default([]),
  /** True once the operator confirms the ToC and chapter generation may begin. */
  tocConfirmed: z.boolean().default(false),
  coverImage: EbookImageSlotSchema.nullable().optional(),
});
export type EbookDoc = z.infer<typeof EbookDocSchema>;

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
  /** Content ANGLE for a spoke (framework id, src/lib/content/frameworks.ts); null for
   *  hub/promo. Angles live on the node — the graph is the source of truth. Optional so
   *  pre-existing saved plans (no angle) still parse and generate as before. */
  framework: z.string().max(40).nullable().optional(),
  /** Per-node generation instruction the Architect wrote. */
  brief: z.string().max(2000).nullable().optional(),
  /** FINAL filled copy — "" until generated. This IS the Distribute payload body. */
  body: z.string().max(MAX_BODY_CHARS).default(""),
  /** Filled {{token}} values, reconciled against the body. */
  placeholderValues: z.record(z.string(), z.string()).default({}),
  status: ContentNodeStatus.default("empty"),
  /** Distribute fills this (ISO); null until scheduled. */
  scheduledAt: z.string().nullable().optional(),
  /** Distribute lifecycle badge (scheduled → posting → posted/failed); null until scheduled.
   *  Server-owned: written by the schedule route + Distribute worker, never by canvas editing. */
  distributionStatus: ContentDistributionStatus.nullable().optional(),
  warnings: z.array(z.string()).default([]),
  // ── Email-sequence fields (only on `email`/`wait`/`condition` nodes; null/[]
  //    elsewhere so hub-and-spoke plans are unaffected). ──
  /** Email node — the subject line (email nodes only). */
  subject: z.string().max(200).nullable().optional(),
  /** Email node — inbox preview / preheader text. */
  previewText: z.string().max(200).nullable().optional(),
  /** Email node — 2-3 alternative subject lines for A/B testing. */
  subjectVariants: z.array(z.string().max(200)).max(4).default([]),
  /** Wait node — the delay before the next step. */
  waitConfig: z
    .object({
      amount: z.number().int().positive().max(365),
      unit: z.enum(["hours", "days"]),
    })
    .nullable()
    .optional(),
  /** Condition node — a branch split (visual only; not executed). */
  conditionConfig: z
    .object({
      label: z.string().max(120),
      yesLabel: z.string().max(60).default("Yes"),
      noLabel: z.string().max(60).default("No"),
    })
    .nullable()
    .optional(),
  /** Email node — optional visual LAYOUT. When present, `body` is DERIVED via
   *  renderEmailLayout(layout) and the AI copy lives in the role:"copy" block. */
  layout: EmailLayoutSchema.nullable().optional(),
  // ── Social post image (linkedin/x/instagram nodes; author-time on-brand image).
  //    Additive + nullable so hub-and-spoke / email plans are unaffected and old
  //    plans still parse. Persisted through the whole-graph PUT (ContentGraphSchema). ──
  /** Workspace-asset FILENAME of the generated post image (served via the
   *  authenticated /api/admin/workspace/{ws}/asset proxy); null = none. */
  imageAssetRef: z.string().max(2000).nullable().optional(),
  /** The operator-chosen social aspect ratio the image was rendered at. */
  imageAspect: z.enum(["1:1", "4:5", "1.91:1"]).nullable().optional(),
  /** The expanded image prompt (transparency / re-roll reference). */
  imagePrompt: z.string().max(1000).nullable().optional(),
  // ── eBook hub (only on the `hub` node of an "ebook" plan; null elsewhere). The
  //    authored book is copied here from `ContentPlan.ebookDraft` at finalize so the
  //    canvas hub node IS the eBook. Additive + nullable so old/other plans parse. ──
  ebook: EbookDocSchema.nullable().optional(),
});
export type ContentNode = z.infer<typeof ContentNodeSchema>;

export const ContentEdgeSchema = z.object({
  id: z.string().min(1).max(96),
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  /** Branch label ("Yes"/"No") for a condition node's outgoing edges. */
  label: z.string().max(40).nullable().optional(),
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
  /** The chosen sequence archetype (only when objective === "email_sequence"). */
  sequenceType: SequenceType.nullable().optional(),
});
export type ContentStrategy = z.infer<typeof ContentStrategySchema>;

export const ContentScopeSchema = z.object({
  /** Content Matrix topic ids to ground + organise around. */
  topics: z.array(z.string().max(60)).max(26).default([]),
  /** The angle / thesis the operator wants this workflow to make. */
  spark: z.string().max(4000).default(""),
  /** eBook only — the industry framing/lens to write through (grounds ToC + chapters). */
  industryLens: z.string().max(500).default(""),
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
  hubChannel: z.enum(["newsletter", "blog", "ebook"]).default("newsletter"),
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
  /** eBook only — the book being authored in the studio BEFORE it's finalized onto the
   *  canvas hub node. Null for newsletter/blog/sequence plans and until the ToC exists. */
  ebookDraft: EbookDocSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

export const CONTENT_PLAN_LIMITS = {
  MAX_NODES,
  MAX_EDGES,
  MAX_BODY_CHARS,
  MAX_EMAIL_BLOCKS,
  MAX_CHAPTERS,
  MAX_IMAGES_PER_CHAPTER,
  MAX_CHAPTER_CHARS,
} as const;
