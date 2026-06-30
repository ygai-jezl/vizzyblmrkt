import { z } from "zod";

/**
 * A Workspace — the top-level container for the "Content OS". Each workspace has
 * its OWN knowledge base (grounding data, ingested in the Curate pillar) and,
 * over time, its own templates / drafts / distribution. Tenant-scoped, stored in
 * the regional `workspaces` collection (like `campaigns`).
 *
 * Distinct from a campaign/launch: a campaign is a waitlist; a workspace is a
 * content-production space. Knowledge ownership is polymorphic
 * (ownerKind: "campaign" | "workspace") so both can ground AI generation — see
 * src/lib/tenant/knowledge.ts.
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  /** Authority Content Matrix topics this workspace wants to own (Settings tab). */
  topics: z.array(z.string()).default([]),
  /** Default free-form tags suggested for new grounding sources. */
  defaultTags: z.array(z.string()).default([]),
  /** Custom structural group names accumulated from templatizing (combobox options). */
  templateGroups: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set when the workspace is archived (hidden from the active list). */
  archivedAt: z.string().nullable().optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
