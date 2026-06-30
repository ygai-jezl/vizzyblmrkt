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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;
