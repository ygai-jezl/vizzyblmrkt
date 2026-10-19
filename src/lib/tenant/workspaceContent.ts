import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { forTenant } from "./repository";
import type { FirestoreLike, TenantContext } from "./types";
import { IdeaItemSchema, type IdeaItem } from "@/lib/types/ideaItem";
import { TemplateSchema, type Template } from "@/lib/types/template";
import { EmailTemplateSchema, type EmailTemplate } from "@/lib/types/emailTemplate";
import {
  BlogArticleMetaSchema,
  ContentPlanSchema,
  ContentNodeSchema,
  EbookDocSchema,
  EbookChapterSchema,
  CONTENT_PLAN_LIMITS,
  type BlogArticleLive,
  type BlogHero,
  type ContentPlan,
  type ContentNode,
  type EbookDoc,
  type EbookChapter,
} from "@/lib/types/contentPlan";
import { sanitizeEbookHtmlCapped, reconcileChapterImages } from "@/lib/content/create/ebookHtml";

/**
 * Tenant-layer access for a workspace's Content OS subcollections:
 *   workspaces/{workspaceId}/idea_items/{id}      (Idea Board captures)
 *   workspaces/{workspaceId}/templates/{id}       (templatized skeletons)
 *   workspaces/{workspaceId}/content_plans/{id}   (Create-pillar workflows)
 * in the tenant's REGIONAL database.
 *
 * SECURITY: like src/lib/tenant/knowledge.ts, the parent workspace doc is the
 * tenant boundary — callers MUST `verifyWorkspace(ctx, workspaceId)` first (a
 * tenant-scoped getById that returns false for a foreign/missing workspace). Every
 * doc also stamps tenantId+workspaceId as defence-in-depth.
 */
const IDEA_ITEMS = "idea_items" as const;
const TEMPLATES = "templates" as const;
const EMAIL_TEMPLATES = "email_templates" as const;
const CONTENT_PLANS = "content_plans" as const;

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
  if (!parsed.success) return null;
  if (parsed.data.tenantId !== ctx.tenantId || parsed.data.workspaceId !== workspaceId) return null;
  return parsed.data;
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
  db?: FirestoreLike,
): Promise<Template[]> {
  // A test's FakeFirestore backs the slash-path collection (see contentPlans()).
  const col = db ? db.collection(`workspaces/${workspaceId}/${TEMPLATES}`) : workspaceDoc(ctx, workspaceId).collection(TEMPLATES);
  const snap = await col.limit(Math.min(Math.max(limit, 1), 1000)).get();
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
  if (!parsed.success) return null;
  if (parsed.data.tenantId !== ctx.tenantId || parsed.data.workspaceId !== workspaceId) return null;
  return parsed.data;
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

// ── Email templates (saved visual layouts) ───────────────────────────────────

export type CreateEmailTemplateInput = Omit<
  EmailTemplate,
  "id" | "tenantId" | "workspaceId" | "createdAt" | "updatedAt"
>;

export async function createEmailTemplate(
  ctx: TenantContext,
  workspaceId: string,
  input: CreateEmailTemplateInput,
): Promise<EmailTemplate> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const tpl = EmailTemplateSchema.parse({
    ...input,
    id,
    tenantId: ctx.tenantId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  });
  await workspaceDoc(ctx, workspaceId).collection(EMAIL_TEMPLATES).doc(id).set(tpl);
  return tpl;
}

export async function listEmailTemplates(
  ctx: TenantContext,
  workspaceId: string,
  limit = 300,
): Promise<EmailTemplate[]> {
  const snap = await workspaceDoc(ctx, workspaceId)
    .collection(EMAIL_TEMPLATES)
    .limit(Math.min(Math.max(limit, 1), 1000))
    .get();
  const rows: EmailTemplate[] = [];
  for (const d of snap.docs) {
    const parsed = EmailTemplateSchema.safeParse(d.data());
    if (parsed.success) rows.push(parsed.data);
    else console.warn(`[workspaceContent] dropped invalid email template ${d.id}:`, parsed.error.message);
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export async function getEmailTemplate(
  ctx: TenantContext,
  workspaceId: string,
  templateId: string,
): Promise<EmailTemplate | null> {
  const doc = await workspaceDoc(ctx, workspaceId).collection(EMAIL_TEMPLATES).doc(templateId).get();
  if (!doc.exists) return null;
  const parsed = EmailTemplateSchema.safeParse(doc.data());
  if (!parsed.success) return null;
  if (parsed.data.tenantId !== ctx.tenantId || parsed.data.workspaceId !== workspaceId) return null;
  return parsed.data;
}

export async function deleteEmailTemplate(
  ctx: TenantContext,
  workspaceId: string,
  templateId: string,
): Promise<void> {
  await workspaceDoc(ctx, workspaceId).collection(EMAIL_TEMPLATES).doc(templateId).delete();
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

// ── Content plans (Create pillar) ──────────────────────────────────────────────

export type CreateContentPlanInput = Omit<
  ContentPlan,
  "id" | "tenantId" | "workspaceId" | "createdAt" | "updatedAt"
>;

/**
 * A workspace's content_plans subcollection. Slash-path ref (like updateContentPlan)
 * so a test's FakeFirestore can back it; the real SDK reads the nested collection.
 */
function contentPlans(ctx: TenantContext, workspaceId: string, db?: FirestoreLike) {
  const database = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  return database.collection(`workspaces/${workspaceId}/${CONTENT_PLANS}`);
}

export async function createContentPlan(
  ctx: TenantContext,
  workspaceId: string,
  input: CreateContentPlanInput,
  db?: FirestoreLike,
): Promise<ContentPlan> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const plan = ContentPlanSchema.parse({
    ...input,
    id,
    tenantId: ctx.tenantId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  });
  await contentPlans(ctx, workspaceId, db).doc(id).set(plan);
  return plan;
}

export async function listContentPlans(
  ctx: TenantContext,
  workspaceId: string,
  limit = 200,
  db?: FirestoreLike,
): Promise<ContentPlan[]> {
  const snap = await contentPlans(ctx, workspaceId, db)
    .limit(Math.min(Math.max(limit, 1), 500))
    .get();
  const rows: ContentPlan[] = [];
  for (const d of snap.docs) {
    const parsed = ContentPlanSchema.safeParse(d.data());
    if (parsed.success) rows.push(parsed.data);
    else console.warn(`[workspaceContent] dropped invalid content_plan ${d.id}:`, parsed.error.message);
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export async function getContentPlan(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  db?: FirestoreLike,
): Promise<ContentPlan | null> {
  const doc = await contentPlans(ctx, workspaceId, db).doc(planId).get();
  if (!doc.exists) return null;
  const parsed = ContentPlanSchema.safeParse(doc.data());
  if (!parsed.success) return null;
  // Defence in depth: never return a doc whose stamped owner doesn't match (matches
  // the TenantCollection.getById / knowledgeRetrieval re-check pattern).
  if (parsed.data.tenantId !== ctx.tenantId || parsed.data.workspaceId !== workspaceId) return null;
  return parsed.data;
}

/** Patch a plan's name / status / graph / eBook draft (full-field replace).
 *
 * The distribution fields (`distributionStatus`, `scheduledAt`) are SERVER-OWNED — written only
 * by the schedule route + Distribute worker via `updateContentPlanNode`, never by canvas editing.
 * The canvas Save sends its whole in-memory graph, which was seeded once at mount and is unaware
 * of any distribution write that landed since; replacing the graph wholesale would silently revert
 * a worker-written `posted`/`failed` (or a schedule's `scheduledAt`) to a stale value. So when a
 * `graph` is provided we re-read the current doc and overlay each existing node's distribution
 * fields (matched by id) onto the incoming graph before writing — making updateContentPlanNode the
 * single writer of those fields. */
export async function updateContentPlan(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  patch: Partial<
    Pick<ContentPlan, "name" | "status" | "graph" | "ebookDraft" | "authoredBy" | "agentRevision" | "agentBrief" | "blog">
  > & {
    /** The plan's hub URL (an article's address), written alone so the rest of its strategy stays. */
    hubUrl?: string | null;
  },
  // Injectable for tests (a FakeFirestore); defaults to the tenant's regional DB otherwise.
  db?: FirestoreLike,
): Promise<void> {
  const database = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const { hubUrl, ...fields } = patch;
  const strategy = hubUrl !== undefined ? { "strategy.hubUrl": hubUrl } : {};
  // Slash-path collection ref (see updateContentPlanNode) so the real SDK reads the nested
  // subcollection and the fake treats it as a flat keyed map.
  const ref = database.collection(`workspaces/${workspaceId}/${CONTENT_PLANS}`).doc(planId);
  // Fast path: no graph replacement → a plain field update can't clobber node distribution state.
  if (!patch.graph) {
    await ref.update({ ...fields, ...strategy, updatedAt: new Date().toISOString() });
    return;
  }
  // Graph replacement: overlay each existing node's server-owned distribution fields (matched by
  // id) onto the incoming graph, INSIDE a transaction, so a worker write that lands between the
  // read and the write can't be lost (and neither can this write clobber it) — the read+merge+write
  // is atomic, mirroring updateContentPlanNode.
  const incoming = patch.graph;
  await database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? ContentPlanSchema.safeParse(snap.data()) : null;
    const owned = current?.success
      ? new Map(
          current.data.graph.nodes.map(
            (n) =>
              [
                n.id,
                { distributionStatus: n.distributionStatus ?? null, scheduledAt: n.scheduledAt ?? null, live: n.blog?.live, hero: n.blog?.hero },
              ] as const,
          ),
        )
      : new Map<
          string,
          {
            distributionStatus: ContentNode["distributionStatus"];
            scheduledAt: ContentNode["scheduledAt"];
            live: BlogArticleLive | null | undefined;
            hero: BlogHero | undefined;
          }
        >();
    const graph = {
      ...incoming,
      nodes: incoming.nodes.map((n) => {
        const keep = owned.get(n.id);
        if (!keep) return n;
        const { live, hero, ...distribution } = keep;
        return withStoredBlog({ ...n, ...distribution }, { live, hero });
      }),
    };
    tx.update(ref, { ...fields, ...strategy, graph, updatedAt: new Date().toISOString() });
  });
}

/**
 * A blog article's server-owned marks keep their stored values through every other write (a
 * canvas save, a fact check, a rewrite), so none of them can undo one or bring back one that
 * was taken away:
 *  - `blog.live`, set only by the live check or a person's word on it (`setLive` below);
 *  - `blog.hero`, set only by the hero's own writer (`updateBlogHero`). The fact check saves
 *    the whole meta it read at its start, and a hero made meanwhile would otherwise be lost.
 */
function withStoredBlog<N extends Pick<ContentNode, "blog">>(
  node: N,
  stored: { live: BlogArticleLive | null | undefined; hero: BlogHero | undefined },
): N {
  const { live, hero } = stored;
  if (live === undefined && node.blog?.live === undefined && hero === undefined && node.blog?.hero === undefined) return node;
  const blog = { ...(node.blog ?? BlogArticleMetaSchema.parse({})) };
  if (live === undefined) delete blog.live;
  else blog.live = live;
  if (hero === undefined) delete blog.hero;
  else blog.hero = hero;
  return { ...node, blog };
}

/**
 * Persist a SINGLE node's fields (body/placeholders/status/etc.) atomically. Run
 * inside a transaction so concurrent per-node generates (the client fills empty
 * nodes in parallel) don't clobber each other's writes to the shared graph array.
 * Returns the updated node, or null if the plan/node is gone.
 */
export async function updateContentPlanNode(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  nodeId: string,
  patch: Partial<
    Pick<
      ContentNode,
      | "body"
      | "placeholderValues"
      | "status"
      | "scheduledAt"
      | "distributionStatus"
      | "warnings"
      | "brief"
      | "templateId"
      | "format"
      | "subject"
      | "previewText"
      | "subjectVariants"
      | "layout"
      | "ebook"
      | "imageAssetRef"
      | "imageAspect"
      | "imagePrompt"
      | "imageStyleId"
      | "imageHeadline"
      | "imageFormat"
      | "imageFormatInputs"
      | "imageChart"
      | "blog"
    >
  >,
  // Injectable so the Distribute worker (which threads its own FirestoreLike through, a
  // FakeFirestore under test) reflects node status against the SAME db instead of reaching
  // for the real getDb(). Defaults to the tenant's regional DB for all normal callers.
  db?: FirestoreLike,
  /** The live check's own write: the new live mark, from the one stored (read in the transaction). */
  opts: { setLive?: (stored: BlogArticleLive | null) => BlogArticleLive | null } = {},
): Promise<ContentNode | null> {
  const database = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  // Slash-path collection ref (`workspaces/{ws}/content_plans`): the real admin SDK reads it as
  // the nested subcollection, while FirestoreLike/FakeFirestore treats it as a flat keyed map —
  // so the worker's reflection runs against the injected fake in tests instead of real Firestore,
  // and DocRefLike need not expose a `.collection()` the abstraction doesn't model.
  const ref = database.collection(`workspaces/${workspaceId}/${CONTENT_PLANS}`).doc(planId);
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const parsed = ContentPlanSchema.safeParse(snap.data());
    if (!parsed.success) return null;
    const plan = parsed.data;
    // Defence in depth inside the transaction: reject a plan whose stamped owner
    // doesn't match before mutating it.
    if (plan.tenantId !== ctx.tenantId || plan.workspaceId !== workspaceId) return null;
    const idx = plan.graph.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return null;
    const stored = plan.graph.nodes[idx]!;
    const merged = ContentNodeSchema.parse({ ...stored, ...patch });
    const live = opts.setLive ? opts.setLive(stored.blog?.live ?? null) : stored.blog?.live;
    const next = ContentNodeSchema.parse(withStoredBlog(merged, { live, hero: stored.blog?.hero }));
    const nodes = [...plan.graph.nodes];
    nodes[idx] = next;
    tx.update(ref, {
      "graph.nodes": nodes,
      updatedAt: new Date().toISOString(),
    });
    return next;
  });
}

/**
 * The blog hero's own write: `next` gets the stored hero and the node, and returns the hero to
 * save, or "keep" to write nothing (another run holds the lease, or this run was overtaken).
 * In a transaction, like every node write, so a canvas save or fact check landing at the same
 * moment can't lose it. Null when the plan or node is gone or not the caller's.
 */
export async function updateBlogHero(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  nodeId: string,
  next: (stored: BlogHero | undefined, node: ContentNode) => BlogHero | "keep",
  db?: FirestoreLike,
): Promise<{ node: ContentNode; hero: BlogHero | undefined; wrote: boolean } | null> {
  const database = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const ref = database.collection(`workspaces/${workspaceId}/${CONTENT_PLANS}`).doc(planId);
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const parsed = ContentPlanSchema.safeParse(snap.data());
    if (!parsed.success) return null;
    const plan = parsed.data;
    if (plan.tenantId !== ctx.tenantId || plan.workspaceId !== workspaceId) return null;
    const idx = plan.graph.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return null;
    const stored = plan.graph.nodes[idx]!;
    const hero = next(stored.blog?.hero, stored);
    if (hero === "keep") return { node: stored, hero: stored.blog?.hero, wrote: false };
    const node = ContentNodeSchema.parse({ ...stored, blog: { ...(stored.blog ?? BlogArticleMetaSchema.parse({})), hero } });
    const nodes = [...plan.graph.nodes];
    nodes[idx] = node;
    tx.update(ref, { "graph.nodes": nodes, updatedAt: new Date().toISOString() });
    return { node, hero: node.blog?.hero, wrote: true };
  });
}

/**
 * Persist the whole eBook draft atomically (the single mutation point for the studio —
 * ToC edits, chapter writes, image slots, resize, reorder). Runs in a transaction so a
 * chat-driven op and a streamed chapter write can't clobber each other. Re-validates the
 * incoming doc via `EbookDocSchema.parse` and re-checks tenant ownership before writing.
 * Returns the persisted eBook, or null if the plan is gone / not owned by the caller.
 */
export async function updateContentPlanEbook(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  ebook: EbookDoc,
): Promise<EbookDoc | null> {
  const db = getDb(databaseIdForRegion(ctx.region));
  const ref = workspaceDoc(ctx, workspaceId).collection(CONTENT_PLANS).doc(planId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const parsed = ContentPlanSchema.safeParse(snap.data());
    if (!parsed.success) return null;
    const plan = parsed.data;
    if (plan.tenantId !== ctx.tenantId || plan.workspaceId !== workspaceId) return null;
    const next = EbookDocSchema.parse(ebook);
    tx.update(ref, { ebookDraft: next, updatedAt: new Date().toISOString() });
    return next;
  });
}

/**
 * Persist a SINGLE eBook chapter atomically. Unlike updateContentPlanEbook (a whole-doc
 * replace used by the client-authoritative studio PATCH), this re-reads the CURRENT
 * ebookDraft inside the transaction and patches only the target chapter — so a streamed
 * chapter write can't clobber a concurrent edit to a DIFFERENT chapter (the streaming
 * route holds a request-start snapshot for many seconds). Returns the updated chapter, or
 * null if the plan / draft / chapter is gone or not owned by the caller.
 */
export async function updateContentPlanChapter(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  chapterId: string,
  patch: Partial<Pick<EbookChapter, "title" | "summary" | "bodyHtml" | "status" | "images">>,
): Promise<EbookChapter | null> {
  const db = getDb(databaseIdForRegion(ctx.region));
  const ref = workspaceDoc(ctx, workspaceId).collection(CONTENT_PLANS).doc(planId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const parsed = ContentPlanSchema.safeParse(snap.data());
    if (!parsed.success) return null;
    const plan = parsed.data;
    if (plan.tenantId !== ctx.tenantId || plan.workspaceId !== workspaceId) return null;
    const draft = plan.ebookDraft;
    if (!draft) return null;
    const idx = draft.chapters.findIndex((c) => c.id === chapterId);
    if (idx < 0) return null;
    const nextChapter = EbookChapterSchema.parse({ ...draft.chapters[idx], ...patch });
    const chapters = [...draft.chapters];
    chapters[idx] = nextChapter;
    const nextDraft = EbookDocSchema.parse({ ...draft, chapters });
    tx.update(ref, { ebookDraft: nextDraft, updatedAt: new Date().toISOString() });
    return nextChapter;
  });
}

/**
 * Apply a pure read-modify-write to the eBook draft ATOMICALLY: reads the CURRENT
 * `ebookDraft` inside the transaction, runs `mutate`, then server-authoritatively
 * re-sanitizes + caps every chapter body (so no mutate fn — a chat op, an image insert —
 * can ever persist unsafe or oversized markup), validates, and writes. This is the write
 * path for chat ops (applyEbookOps) and image-slot updates: because it re-reads inside the
 * tx, it never clobbers a concurrent write the way a client-supplied whole-doc replace can.
 * Returns the persisted draft, or null if the plan/draft is gone or not owned by the caller.
 */
export async function mutateContentPlanEbookDraft(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  mutate: (draft: EbookDoc) => EbookDoc,
): Promise<EbookDoc | null> {
  const db = getDb(databaseIdForRegion(ctx.region));
  const ref = workspaceDoc(ctx, workspaceId).collection(CONTENT_PLANS).doc(planId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const parsed = ContentPlanSchema.safeParse(snap.data());
    if (!parsed.success) return null;
    const plan = parsed.data;
    if (plan.tenantId !== ctx.tenantId || plan.workspaceId !== workspaceId) return null;
    if (!plan.ebookDraft) return null;
    const mutated = mutate(plan.ebookDraft);
    const safe: EbookDoc = {
      ...mutated,
      chapters: mutated.chapters.map((c) => {
        // Sanitize + cap the body, then reconcile image slots against it: if the cap truncated
        // an anchor, its slot is dropped so bodyHtml and images[] can never disagree.
        const bodyHtml = sanitizeEbookHtmlCapped(c.bodyHtml, CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS);
        return { ...c, bodyHtml, images: reconcileChapterImages(bodyHtml, c.images) };
      }),
    };
    const next = EbookDocSchema.parse(safe);
    tx.update(ref, { ebookDraft: next, updatedAt: new Date().toISOString() });
    return next;
  });
}

export async function deleteContentPlan(
  ctx: TenantContext,
  workspaceId: string,
  planId: string,
  db?: FirestoreLike,
): Promise<void> {
  await contentPlans(ctx, workspaceId, db).doc(planId).delete();
}
