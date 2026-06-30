import { z } from "zod";

/**
 * An "Idea Board" capture — a zero-friction brain-dump item in a workspace's Curate
 * pillar. May carry any of: a reference URL, pasted text, and/or a screenshot
 * (≥1 present). The Templatize action runs it through Gemini to produce a reusable
 * Template (see src/lib/types/template.ts). Stored in the tenant's REGIONAL DB at
 * workspaces/{workspaceId}/idea_items/{id}.
 */
export const IdeaItemStatus = z.enum(["captured", "templatized"]);
export type IdeaItemStatus = z.infer<typeof IdeaItemStatus>;

export const IdeaItemSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).nullable().optional(),
  /** Reference link (citation). */
  url: z.string().max(2000).nullable().optional(),
  /** Pasted text the user wants templatized. */
  text: z.string().max(20000).nullable().optional(),
  /** Private GCS object path for an uploaded screenshot (served via the auth proxy). */
  screenshotPath: z.string().max(500).nullable().optional(),
  /** Derived from `url` at capture (bare host / whether it's auto-fetchable). */
  sourceHost: z.string().max(200).nullable().optional(),
  fetchable: z.boolean().nullable().optional(),
  status: IdeaItemStatus.default("captured"),
  /** The template produced from this idea, once templatized. */
  templateId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IdeaItem = z.infer<typeof IdeaItemSchema>;
