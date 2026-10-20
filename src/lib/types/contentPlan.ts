import { z } from "zod";
import { EmailLayoutSchema, MAX_EMAIL_BLOCKS } from "@/lib/types/emailLayout";
import { ChartSchema, FormatInputsSchema, ImageFormatIdSchema } from "@/lib/types/imageStyle";

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
/** "4:5" is the report cover only (IMAGE_FORMATS_ENABLED); the aspect menu offers the other two. */
export const EbookAspect = z.enum(["1:1", "1:4", "4:5"]);
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
  /** This image's own style, picked when it was made (a style or old preset id); absent = the brand's. */
  imageStyleId: z.string().max(40).nullable().optional(),
  /** v2: the cover as a report cover (IMAGE_FORMATS_ENABLED) and what it draws. */
  format: ImageFormatIdSchema.optional().catch(undefined),
  formatInputs: FormatInputsSchema.optional().catch(undefined),
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

// ── Blog hub, written to the CITABLE structure (flag CREATE_BLOG_CITABLE_ENABLED) ──
// A blog hub carries a BRIEF on the plan (what buyers ask, which pages it may link to,
// which sources it may cite) and a small META record on the hub node (what the writer
// proposed, and what the checks found). All additive + nullable: plans saved before
// this, and every non-blog plan, parse and behave exactly as they did.

/** Only https links are ever written into an article or shown as a link in the admin. */
const HttpsUrl = z
  .string()
  .max(2000)
  .refine((u) => /^https:\/\/[^\s<>"']+$/i.test(u), "must be an https URL");

/** Who put a row in the brief. Research replaces its own rows; a person's rows stay. */
export const BlogRowBy = z.enum(["research", "operator"]);
export type BlogRowBy = z.infer<typeof BlogRowBy>;

/** The buyer intent a question (and its section of the article) answers. */
export const BlogIntent = z.enum([
  "definition",
  "how_to",
  "alternatives",
  "comparison",
  "integrations",
  "use_cases",
  "pricing",
  "limits",
  "benchmarks",
  "other",
]);
export type BlogIntent = z.infer<typeof BlogIntent>;

export const BlogQuestionSchema = z.object({
  question: z.string().min(1).max(300),
  intent: BlogIntent.default("other"),
  by: BlogRowBy.default("operator"),
  /** The brand map question this is, when it is one (its id). Optional with no default, so
   *  briefs saved before the brand map parse exactly as they did. */
  ref: z.string().max(64).optional(),
});
export type BlogQuestion = z.infer<typeof BlogQuestionSchema>;

/** What a page is for when the article links to it: `convert` = a page that turns a
 *  reader into a lead or customer (pricing, demo, sign-up); the rest go deeper. */
export const BlogLinkIntent = z.enum(["convert", "product", "proof", "compare", "learn"]);
export type BlogLinkIntent = z.infer<typeof BlogLinkIntent>;

export const BlogLinkSchema = z.object({
  url: HttpsUrl,
  label: z.string().max(160).default(""),
  intent: BlogLinkIntent.default("learn"),
  by: BlogRowBy.default("operator"),
});
export type BlogLink = z.infer<typeof BlogLinkSchema>;

/**
 * A third-party source the article may cite. `verified` = the figures in `fact` were
 * found on the page itself when research fetched it; `unverified` = search returned the
 * page but the figures could not be confirmed on it (blocked, or not there), so the
 * writer is NOT given it until a person checks it; `operator` = added or confirmed by a
 * person.
 */
export const BlogSourceStatus = z.enum(["verified", "unverified", "operator"]);
export type BlogSourceStatus = z.infer<typeof BlogSourceStatus>;

/**
 * Where research found a source (flag CREATE_BLOG_CITE_SOURCES_ENABLED). `web` = its web
 * search found the page. `cited` = it is one of the brand's CITE SOURCES — a knowledge
 * source marked as one an article may cite — and the fact was checked against the text
 * held from that page. Research looks in both and neither is preferred. Absent on a row
 * a person added, and on every row from before cite sources (those came from the web).
 */
export const BlogSourceOrigin = z.enum(["web", "cited"]);
export type BlogSourceOrigin = z.infer<typeof BlogSourceOrigin>;

export const BlogSourceSchema = z.object({
  url: HttpsUrl,
  title: z.string().max(200).default(""),
  /** The site's own name, else its domain. Never the model's guess at who said it. */
  publisher: z.string().max(120).default(""),
  /** The year the page says it was published; null when the page does not say. */
  year: z.number().int().min(1990).max(2100).nullable().default(null),
  /** One sentence the article may state and cite to this source. */
  fact: z.string().max(600).default(""),
  status: BlogSourceStatus.default("operator"),
  origin: BlogSourceOrigin.optional(),
});
export type BlogSource = z.infer<typeof BlogSourceSchema>;

/** A thing the article should name, and how it relates to the brand. */
export const BlogEntityRelation = z.enum([
  "brand",
  "product",
  "category",
  "alternative",
  "integration",
  "audience",
  "use_case",
]);
export type BlogEntityRelation = z.infer<typeof BlogEntityRelation>;

export const BlogEntitySchema = z.object({
  name: z.string().min(1).max(120),
  relation: BlogEntityRelation,
  by: BlogRowBy.default("operator"),
});
export type BlogEntity = z.infer<typeof BlogEntitySchema>;

/**
 * What the publisher's robots.txt says to the AI answer engines' crawlers (flag
 * CREATE_BLOG_CITE_SOURCES_ENABLED): a page they are kept out of cannot be cited. Read
 * when research runs; shown to the operator with the hand-over, since only whoever runs
 * the site can change it.
 */
export const BlogCrawlerCheckSchema = z.object({
  /** The site whose robots.txt was read, e.g. https://example.com. */
  site: z.string().max(300),
  /** The path the rules were read for: the article's own when its address is known, else "/". */
  path: z.string().max(2000).default("/"),
  /** False when the site has no robots.txt — nobody is kept out. */
  found: z.boolean(),
  /** The crawlers kept away from that path, by the name robots.txt knows them by. */
  blocked: z.array(z.string().max(40)).max(20).default([]),
  checkedAt: z.string(),
});
export type BlogCrawlerCheck = z.infer<typeof BlogCrawlerCheckSchema>;

/** The `why` of a note a person added to an article by hand: a later match keeps it. */
export const SEEN_ADDED_BY_YOU = "Added by you";

/** One of the brand's own first-hand notes (BRAND_NOTES_ENABLED), as an article holds it. */
export const BlogSeenNoteSchema = z.object({
  /** The note's id on Brand › What we've seen. */
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(1200),
  /** Why it was matched to this article, in a few words ("Linked to the subject Pricing"). */
  why: z.string().max(160).default(""),
  /** The note names a customer or person who agreed to be named. */
  canName: z.boolean().default(false),
});
export type BlogSeenNote = z.infer<typeof BlogSeenNoteSchema>;

/**
 * What the brand has seen, for one article (BRAND_NOTES_ENABLED): the notes that match its
 * question strongly (put in by the match, removable), the weaker ones a person may add, what a
 * person wrote for this article alone, and the questions that would help when nothing matched.
 * The editorial writer takes first-hand experience from here and nowhere else.
 */
/**
 * One of the questions an article asked its team (BRAND_NOTES_QUESTIONS_ENABLED): kept on What
 * we've seen as a note of its own. `answer` is a copy of that note's answer for the browser; the
 * note holds the real one, and the server copies it back in before the article is written or checked.
 */
export const BlogSeenQuestionSchema = z.object({
  /** The question's note on Brand › What we've seen. */
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(300),
  answer: z.string().max(1200).default(""),
  /** The other articles that asked it too, by name (a few), so the article shows it is shared. */
  also: z.array(z.string().max(200)).max(3).optional(),
});
export type BlogSeenQuestion = z.infer<typeof BlogSeenQuestionSchema>;

export const BlogSeenSchema = z.object({
  notes: z.array(BlogSeenNoteSchema).max(6).default([]),
  /** Weaker matches: shown on request, never used unless a person adds one. */
  near: z.array(BlogSeenNoteSchema).max(5).default([]),
  /** Notes a person took out of this article: never put back by a later match. */
  removed: z.array(z.string().max(64)).max(50).default([]),
  /** What a person wrote for this article. */
  own: z.string().max(3000).default(""),
  /** Also keep `own` as one of the brand's notes when the article is written (one per article, updated after). */
  save: z.boolean().default(true),
  /** Questions written for this article, shown when nothing matched. */
  asks: z.array(z.string().max(300)).max(3).default([]),
  /** The questions as saved on What we've seen, with their answers (BRAND_NOTES_QUESTIONS_ENABLED). */
  questions: z.array(BlogSeenQuestionSchema).max(3).optional(),
  /** The question the last match ran for; a different question now means match again. */
  matchedFor: z.string().max(300).default(""),
  matchedAt: z.string().nullable().default(null),
});
export type BlogSeen = z.infer<typeof BlogSeenSchema>;

const MAX_BLOG_QUESTIONS = 10;
const MAX_BLOG_LINKS = 12;
const MAX_BLOG_SOURCES = 12;
const MAX_BLOG_ENTITIES = 16;

/** The blog hub's brief. Lives on the plan; research fills it and the operator edits it. */
export const BlogBriefSchema = z.object({
  /** The question the article answers — its H1. "" = research (or the writer) picks one. */
  primaryQuestion: z.string().max(300).default(""),
  /** Whatever the operator knows buyers ask (sales calls, support, search data), pasted as
   *  is. Untrusted DATA in every prompt. */
  buyerQuestions: z.string().max(6000).default(""),
  /** The questions buyers ask next — one section of the article each. */
  questions: z.array(BlogQuestionSchema).max(MAX_BLOG_QUESTIONS).default([]),
  /** The ONLY pages the article may link to on the brand's own site. */
  links: z.array(BlogLinkSchema).max(MAX_BLOG_LINKS).default([]),
  /** The ONLY third-party pages the article may cite. */
  sources: z.array(BlogSourceSchema).max(MAX_BLOG_SOURCES).default([]),
  entities: z.array(BlogEntitySchema).max(MAX_BLOG_ENTITIES).default([]),
  /** The brand the article is published by (suggested schema markup). "" = the programme's name. */
  publisherName: z.string().max(120).default(""),
  /** The brand's site, e.g. https://example.com. "" = left out of the markup. */
  publisherUrl: z.union([HttpsUrl, z.literal("")]).default(""),
  /** A named author for the byline. "" = the brand is the author. */
  author: z.string().max(120).default(""),
  /** When research last ran (ISO); null = never. */
  researchedAt: z.string().nullable().default(null),
  /** Whether AI crawlers may read the article, as of the last research. Null or absent =
   *  not looked at, or the site's robots.txt could not be read. */
  crawlers: BlogCrawlerCheckSchema.nullable().optional(),
  /** The brand map subject this article is for (CREATE_BLOG_BRAND_MAP_ENABLED): absent = not
   *  looked at yet (research may pick one), null = a person said none, an id = chosen. */
  subjectId: z.string().max(64).nullable().optional(),
  /** The brand map question the article's main question is (its id), when it is one. */
  primaryRef: z.string().max(64).optional(),
  /** The buying situation the article is written for (BRAND_MAP_SITUATIONS_ENABLED): absent =
   *  not looked at yet (research may pick one), null = a person said none, an id = chosen. */
  situationId: z.string().max(64).nullable().optional(),
  /** The author's role, for the byline and the author box (CREATE_BLOG_EDITORIAL_ENABLED).
   *  Optional with no default, so briefs saved before parse exactly as they did. */
  authorRole: z.string().max(120).optional(),
  /** A few sentences about the author, shown word for word in the author box at the end. */
  authorBio: z.string().max(600).optional(),
  /** The author's own profile page (the client's, never ours), for the markup's sameAs. */
  authorUrl: z.union([HttpsUrl, z.literal("")]).optional(),
  /** What the brand has seen, for this article (BRAND_NOTES_ENABLED). Absent = never matched. */
  seen: BlogSeenSchema.optional(),
  /** "editorial" once research ran for the editorial writer; absent = researched before (or never), so
   *  an editorial article is researched again before it is written. */
  researchStyle: z.enum(["editorial"]).optional(),
});
export type BlogBrief = z.infer<typeof BlogBriefSchema>;

/** One sentence the fact check changed because the brand's material does not say it. */
export const BlogCorrectionSchema = z.object({
  /** The sentence as the writer had it. */
  before: z.string().max(600),
  /** What it was changed to; "" = it was taken out. */
  after: z.string().max(600).default(""),
  /** Why, in a few words. */
  reason: z.string().max(200).default(""),
});
export type BlogCorrection = z.infer<typeof BlogCorrectionSchema>;

/** That the article is live at its address (BRAND_MAP_PAGES_ENABLED): seen by the live check,
 *  or said by a person (for a site that turns the check away, or fills its title in late). */
export const BlogArticleLiveSchema = z.object({
  /** The address it was live at; a different address since means it has not been seen there. */
  url: z.string().max(2000),
  /** When it was first seen live at that address (kept by later checks: "newer" and "older" go by it). */
  at: z.string().max(40),
  by: z.enum(["check", "operator"]),
  /** The page's title was the article's when it was checked. */
  titleMatched: z.boolean().default(false),
  /** When the live check last found it. */
  checkedAt: z.string().max(40).optional(),
  /** The live page carries a share image (og:image), as last checked (BLOG_HERO_ENABLED). */
  shareImage: z.boolean().optional(),
});
export type BlogArticleLive = z.infer<typeof BlogArticleLiveSchema>;

/**
 * A blog article's hero image (BLOG_HERO_ENABLED): made after the fact check, in the
 * brand's style or the article's own pick. Server-owned, like `live`: a canvas save or a
 * fact check never overwrites it (src/lib/tenant/workspaceContent.ts).
 */
export const BlogHeroSchema = z.object({
  /** pending = being made; ready; fallback = the title card (the image model failed); failed = not saved. */
  status: z.enum(["pending", "ready", "fallback", "failed"]),
  /** The style it was made in (a style id, or "title_card"). */
  styleId: z.string().max(40).nullable().default(null),
  /** The article's own style pick; absent = the brand's. */
  styleOverride: z.string().max(40).nullable().optional(),
  /** Workspace-asset filenames: the 1600x900 hero and the 1200x630 share card. */
  heroRef: z.string().max(2000).nullable().default(null),
  shareRef: z.string().max(2000).nullable().default(null),
  alt: z.string().max(250).default(""),
  /** The image prompt, for a model style. */
  prompt: z.string().max(1000).nullable().optional(),
  attempts: z.number().int().min(0).max(10).default(0),
  error: z.string().max(200).nullable().optional(),
  /** The headline it was made for, to say "the title changed since". */
  forTitle: z.string().max(200).default(""),
  note: z.enum(["no_screenshot", "bundled_font", "no_numbers"]).nullable().optional(),
  /** v2: a format for the hero (IMAGE_FORMATS_ENABLED), what it draws, and Data story's numbers. */
  format: ImageFormatIdSchema.optional().catch(undefined),
  formatInputs: FormatInputsSchema.optional().catch(undefined),
  chart: ChartSchema.optional().catch(undefined),
  /** The Brand Kit image record of the hero, for its thumbs (learning per style). */
  assetId: z.string().max(128).nullable().optional(),
  startedAt: z.string().max(40).nullable().default(null),
  updatedAt: z.string().max(40).nullable().default(null),
});
export type BlogHero = z.infer<typeof BlogHeroSchema>;

/** What the writer proposed for a blog hub, and what the checks found. On the hub node. */
export const BlogArticleMetaSchema = z.object({
  metaTitle: z.string().max(120).default(""),
  metaDescription: z.string().max(320).default(""),
  slug: z.string().max(120).default(""),
  /** The date stamped into the article's "Last updated" line (YYYY-MM-DD, server clock). */
  lastUpdated: z.string().max(10).default(""),
  /** Figures in the copy that were not found in anything the writer was given. */
  unsupportedFigures: z.array(z.string().max(60)).max(20).default([]),
  /** Links the writer used that were not on the allowed lists (taken out of the copy). */
  removedLinks: z.array(z.string().max(300)).max(20).default([]),
  /** When the fact check last ran on this copy (ISO); null = not yet. */
  checkedAt: z.string().nullable().default(null),
  /** What the fact check changed, for the operator to see. */
  corrections: z.array(BlogCorrectionSchema).max(12).default([]),
  /** Live at its address. Optional with no default, so metas saved before parse exactly as they did. */
  live: BlogArticleLiveSchema.nullable().optional(),
  /** The shape the article was written in: "editorial" (CREATE_BLOG_EDITORIAL_ENABLED), else
   *  absent = the CITABLE structure. Its checklist follows this, not the switch. */
  style: z.enum(["editorial"]).optional(),
  /** The hero image (BLOG_HERO_ENABLED). Optional with no default, so old metas parse exactly as they did. */
  hero: BlogHeroSchema.optional(),
  /** Where the client put the hero / share card on their own site (https). Our hosted addresses
   *  never go into client markup, so the image is in the export only once one is set. */
  imageUrl: z.string().max(2000).optional(),
  shareImageUrl: z.string().max(2000).optional(),
});
export type BlogArticleMeta = z.infer<typeof BlogArticleMetaSchema>;

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
  /** This image's own style, picked when it was made (a style or old preset id); absent/null =
   *  the brand's (BRAND_IMAGE_STYLE_ENABLED). Saved so a regenerate keeps it. */
  imageStyleId: z.string().max(40).nullable().optional(),
  /** Brand image style: the words drawn on this post's image (`*stars*` mark the highlight). */
  imageHeadline: z.string().max(160).nullable().optional(),
  /** v2: this post's image format, what it draws, and Data story's numbers. Saved with the post. */
  imageFormat: ImageFormatIdSchema.optional().catch(undefined),
  imageFormatInputs: FormatInputsSchema.optional().catch(undefined),
  imageChart: ChartSchema.optional().catch(undefined),
  // ── eBook hub (only on the `hub` node of an "ebook" plan; null elsewhere). The
  //    authored book is copied here from `ContentPlan.ebookDraft` at finalize so the
  //    canvas hub node IS the eBook. Additive + nullable so old/other plans parse. ──
  ebook: EbookDocSchema.nullable().optional(),
  // ── Blog hub (only on the `hub` node of a blog plan written to the CITABLE structure;
  //    null elsewhere). Additive + nullable so old/other plans parse. ──
  blog: BlogArticleMetaSchema.nullable().optional(),
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
  /** Blog only — the hub's brief (buyer questions, allowed links and sources). Null for
   *  every other plan, and for blog plans made before the CITABLE structure. */
  blog: BlogBriefSchema.nullable().optional(),
  /** Who made the plan: a person, or Vizzy from chat (nav v2 phase 4). Absent = a person. */
  authoredBy: z.enum(["human", "agent"]).optional(),
  /** Bumped on each Vizzy save; the canvas remounts on a change so it shows Vizzy's version. */
  agentRevision: z.number().int().nonnegative().optional(),
  /** What the operator asked Vizzy for, kept for the record. */
  agentBrief: z.string().max(4000).optional(),
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
  MAX_BLOG_QUESTIONS,
  MAX_BLOG_LINKS,
  MAX_BLOG_SOURCES,
  MAX_BLOG_ENTITIES,
} as const;
