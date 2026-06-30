import { randomUUID } from "node:crypto";
import { forTenant, deleteOwnerKnowledge } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Workspace } from "@/lib/types/workspace";

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string | null;
}

/** Create a workspace (id = slug + short random for a readable, unique URL). */
export async function createWorkspace(
  ctx: TenantContext,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const now = new Date().toISOString();
  const id = `${slugify(input.name)}-${randomUUID().slice(0, 6)}`;
  await forTenant(ctx).workspaces.create(id, {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  const ws = await forTenant(ctx).workspaces.getById(id);
  if (!ws) throw new Error("workspace_create_failed");
  return ws;
}

/**
 * Delete a workspace + cascade its knowledge: all chunks under
 * workspaces/{id}/knowledge_bases AND its ingestion_tickets. Returns false if the
 * workspace doesn't exist / isn't owned by the tenant.
 */
export async function deleteWorkspace(
  ctx: TenantContext,
  workspaceId: string,
): Promise<boolean> {
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return false;

  // 1. Chunks (subcollection).
  await deleteOwnerKnowledge(ctx, "workspace", workspaceId).catch(() => 0);

  // 2. Ingestion tickets for this workspace.
  const tickets = await forTenant(ctx).ingestionTickets.find({
    where: [
      ["ownerKind", "==", "workspace"],
      ["ownerId", "==", workspaceId],
    ],
    limit: 500,
  });
  for (const t of tickets) {
    await forTenant(ctx).ingestionTickets.delete(t.id).catch(() => {});
  }

  // 3. The workspace doc.
  await forTenant(ctx).workspaces.delete(workspaceId);
  return true;
}
