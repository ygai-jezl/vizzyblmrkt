import { z } from "zod";
import { EmailLayoutSchema } from "@/lib/types/emailLayout";

/**
 * A saved, reusable email LAYOUT template. Stored at
 * workspaces/{workspaceId}/email_templates/{id} in the tenant's regional DB (same
 * tenant-boundary pattern as content templates / idea_items). Distinct from the
 * content `templates` collection (skeleton/token templates for the Create nodes).
 */
export const EmailTemplateSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1).max(200),
  layout: EmailLayoutSchema,
  /** Rendered HTML snapshot for list thumbnails / previews (renderEmailLayout output). */
  thumbnailBody: z.string().max(20000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;
