import { z } from "zod";

/**
 * A reusable content TEMPLATE — a skeleton with {{placeholder}} tokens produced by
 * the Templatize step (Gemini) from an Idea Board capture. Two independent
 * taxonomies (both AI-suggested, user-editable):
 *  - `category` = content INTENT (the 4 E's; fixed enum). Keep IN SYNC with
 *    src/lib/content/templateCategories.ts (a test asserts parity).
 *  - `group` = structural/modular block (free-form, user-creatable — e.g.
 *    "Newsletter/Podcast", "Pre-Hub CTA").
 * Stored at workspaces/{workspaceId}/templates/{id} in the tenant's REGIONAL DB.
 */
export const TemplateCategoryId = z.enum([
  "educate",
  "empathise",
  "entertain",
  "challenge",
]);
export type TemplateCategoryId = z.infer<typeof TemplateCategoryId>;

export const ModuleSizeId = z.enum(["small", "medium", "large"]);
export type ModuleSizeId = z.infer<typeof ModuleSizeId>;

export const TemplateTier = z.enum(["hub", "spoke", "standalone"]);
export type TemplateTier = z.infer<typeof TemplateTier>;

export const PlaceholderKind = z.enum(["word", "phrase", "sentence", "paragraph", "list-item"]);
export type PlaceholderKind = z.infer<typeof PlaceholderKind>;

/** A structured, typed placeholder extracted from the template body ({{Token}}). */
export const TemplatePlaceholderSchema = z.object({
  /** The token name WITHOUT braces, e.g. "WinningOutcome". */
  token: z.string().min(1).max(60),
  label: z.string().max(80),
  hint: z.string().max(240).optional(),
  kind: PlaceholderKind.default("phrase"),
  /** True when the token repeats (e.g. a list item the user fills N times). */
  repeatable: z.boolean().default(false),
});
export type TemplatePlaceholder = z.infer<typeof TemplatePlaceholderSchema>;

export const TemplateSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1).max(200),
  /** The template body, with {{Token}} placeholders. */
  body: z.string().min(1).max(10000),
  category: TemplateCategoryId,
  /** Structural group label (free-form; user-creatable). */
  group: z.string().min(1).max(100),
  /** The idea this was generated from (if any). */
  sourceIdeaId: z.string().nullable().optional(),
  /** Optional Content Matrix topic id. */
  topic: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  // ── Modular metadata (all optional; pre-v2 templates parse without them) ──
  /** Presentation STYLE (src/lib/content/frameworks.ts). */
  framework: z.string().nullable().optional(),
  /** Modular ROLE (src/lib/content/blocks.ts). */
  blockType: z.string().nullable().optional(),
  moduleSize: ModuleSizeId.nullable().optional(),
  /** Destination channel + native format (src/lib/content/channels.ts). */
  channel: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  /** Topic-cluster position. */
  tier: TemplateTier.nullable().optional(),
  /** For a spoke: the hub/parent template it was deconstructed from. */
  parentTemplateId: z.string().nullable().optional(),
  /** Structured, typed placeholders mirroring the {{tokens}} in the body. */
  placeholders: z.array(TemplatePlaceholderSchema).default([]),
  /** 0-1 confidence the skeleton/structure is clean. */
  confidence: z.number().min(0).max(1).nullable().optional(),
  warnings: z.array(z.string()).default([]),
  /** Capped snapshot of the source content, so reframe/deconstruct are self-contained. */
  sourceSnapshot: z.string().max(8000).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;
