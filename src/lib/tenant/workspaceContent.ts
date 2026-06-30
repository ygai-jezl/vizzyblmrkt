import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { forTenant } from "./repository";
import type { FirestoreLike, TenantContext } from "./types";
import { IdeaItemSchema, type IdeaItem } from "@/lib/types/ideaItem";
import { TemplateSchema, type Template } from "@/lib/types/template";

/**
 * Tenant-layer access for a workspace's Content OS subcollections:
 *   workspaces/{workspaceId}/idea_items/{id}   (Idea Board captures)
 *   workspaces/{workspaceId}/templates/{id}    (templatized skeletons)
 * in the tenant's REGIONAL database.
 *
 * SECURITY: like src/lib/tenant/knowledge.ts, the parent workspace doc is the
 * tenant boundary — callers MUST `verifyWorkspace(ctx, workspaceId)` first (a
 * tenant-scoped getById that returns false for a foreign/missing workspace). Every
 * doc also stamps tenantId+workspaceId as defence-in-depth.
 */
const IDEA_ITEMS = "idea_items" as const;
const TEMPLATES = "templates" as const;

function workspaceDoc(ctx: TenantContext, workspaceId: string) {
  return getDb(databaseIdForRegion(ctx.region)).collection("workspaces").doc(workspaceId);
}

export async function verifyWorkspace(
  ctx: TenantContext,
  workspaceId: string,
  db?: FirestoreLike,
): Promise<boolean> {
  return Boolean(await forTenant(ctx, db).workspaces.getById(workspaceId));
}

// ── Idea items ───────────────────────────────────────────────────────────────

export type CreateIdeaInput = Omit<
  IdeaItem,
  "id" | "tenantId" | "workspaceId" | "createdAt" | "updatedAt"
>;

export async function createIdeaItem(
  ctx: TenantContext,
  workspaceId: string,
  input: CreateIdeaInput,
): Promise<IdeaItem> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const item = IdeaItemSchema.parse({
    ...input,
    id,
    tenantId: ctx.tenantId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  });
  await workspaceDoc(ctx, workspaceId).collection(IDEA_ITEMS).doc(id).set(item);
  return item;
}

export async function listIdeaItems(
  ctx: TenantContext,
  workspaceId: string,
  limit = 200,
): Promise<IdeaItem[]> {
  const snap = await workspaceDoc(ctx, workspaceId)
    .collection(IDEA_ITEMS)
    .limit(Math.min(Math.max(limit, 1), 500))
    .get();
  const rows: IdeaItem[] = [];
  for (const d of snap.docs) {
    const parsed = IdeaItemSchema.safeParse(d.data());
    if (parsed.success) rows.push(parsed.data);
    else console.warn(`[workspaceContent] dropped invalid idea_item ${d.id}:`, parsed.error.message);
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export async function getIdeaItem(
  ctx: TenantContext,
  workspaceId: string,
  ideaId: string,
): Promise<IdeaItem | null> {
  const doc = await workspaceDoc(ctx, workspaceId).collection(IDEA_ITEMS).doc(ideaId).get();
  if (!doc.exists) return null;
  const parsed = IdeaItemSchema.safeParse(doc.data());
  return parsed.success ? parsed.data : null;
}

export async function updateIdeaItem(
  ctx: TenantContext,
  workspaceId: string,
  ideaId: string,
  patch: Partial<Pick<IdeaItem, "status" | "templateId" | "title" | "note">>,
): Promise<void> {
  await workspaceDoc(ctx, workspaceId)
    .collection(IDEA_ITEMS)
    .doc(ideaId)
    .update({ ...patch, updatedAt: new Date().toISOString() });
}

export async function deleteIdeaItem(
  ctx: TenantContext,
  workspaceId: string,
  ideaId: string,
): Promise<void> {
  await workspaceDoc(ctx, workspaceId).collection(IDEA_ITEMS).doc(ideaId).delete();
}

// ── Templates ────────────────────────────────────────────────────────────────

export type CreateTemplateInput = Omit<
  Template,
  "id" | "tenantId" | "workspaceId" | "createdAt" | "updatedAt"
>;

export async function createTemplate(
  ctx: TenantContext,
  workspaceId: string,
  input: CreateTemplateInput,
): Promise<Template> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const tpl = TemplateSchema.parse({
    ...input,
    id,
    tenantId: ctx.tenantId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  });
  await workspaceDoc(ctx, workspaceId).collection(TEMPLATES).doc(id).set(tpl);
  return tpl;
}

export async function listTemplates(
  ctx: TenantContext,
  workspaceId: string,
  limit = 300,
): Promise<Template[]> {
  const snap = await workspaceDoc(ctx, workspaceId)
    .collection(TEMPLATES)
    .limit(Math.min(Math.max(limit, 1), 1000))
    .get();
  const rows: Template[] = [];
  for (const d of snap.docs) {
    const parsed = TemplateSchema.safeParse(d.data());
    if (parsed.success) rows.push(parsed.data);
    else console.warn(`[workspaceContent] dropped invalid template ${d.id}:`, parsed.error.message);
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export async function getTemplate(
  ctx: TenantContext,
  workspaceId: string,
  templateId: string,
): Promise<Template | null> {
  const doc = await workspaceDoc(ctx, workspaceId).collection(TEMPLATES).doc(templateId).get();
  if (!doc.exists) return null;
  const parsed = TemplateSchema.safeParse(doc.data());
  return parsed.success ? parsed.data : null;
}

export async function updateTemplate(
  ctx: TenantContext,
  workspaceId: string,
  templateId: string,
  patch: Partial<
    Pick<
      Template,
      | "title"
      | "body"
      | "category"
      | "group"
      | "topic"
      | "tags"
      | "framework"
      | "blockType"
      | "moduleSize"
      | "channel"
      | "format"
      | "tier"
      | "placeholders"
      | "confidence"
      | "warnings"
      | "sourceSnapshot"
    >
  >,
): Promise<void> {
  await workspaceDoc(ctx, workspaceId)
    .collection(TEMPLATES)
    .doc(templateId)
    .update({ ...patch, updatedAt: new Date().toISOString() });
}

export async function deleteTemplate(
  ctx: TenantContext,
  workspaceId: string,
  templateId: string,
): Promise<void> {
  const col = workspaceDoc(ctx, workspaceId).collection(TEMPLATES);
  // Cascade: delete any spoke children first so they can't be orphaned.
  const children = await col.where("parentTemplateId", "==", templateId).get();
  const docs = children.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = col.firestore.batch();
    for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  await col.doc(templateId).delete();
}

/**
 * Append a new structural group to the workspace's `templateGroups` (combobox
 * options). Uses arrayUnion so concurrent templatize calls don't clobber each
 * other (the read-modify-write race). Verifies the workspace is the tenant's
 * first, then writes by document path (tenant-scoped via that check).
 */
export async function addTemplateGroup(
  ctx: TenantContext,
  workspaceId: string,
  group: string,
): Promise<void> {
  const g = group.trim();
  if (!g) return;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return; // tenant-scoped existence check
  if ((ws.templateGroups ?? []).some((x) => x.toLowerCase() === g.toLowerCase())) return;
  await workspaceDoc(ctx, workspaceId).update({
    templateGroups: FieldValue.arrayUnion(g),
    updatedAt: new Date().toISOString(),
  });
}
