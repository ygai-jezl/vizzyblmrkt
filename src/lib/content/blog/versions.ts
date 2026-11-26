import { forTenant } from "@/lib/tenant";
import { updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ArticleVersion, ArticleVersionsDoc, VersionReason } from "@/lib/types/articleRefresh";
import { BlogArticleMetaSchema, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";

/**
 * A blog article's earlier versions (BLOG_REFRESH_ENABLED): the copy is kept just before Apply,
 * Regenerate or Restore replaces it, the last 10 per article, in one doc read by id
 * (`av_<planId>`). Restore puts a version back and keeps the copy it replaces, so a Restore can be
 * undone. Neither ever touches the live mark, the hero or Published: those are the article's,
 * not the copy's. /help/write-and-schedule#versions explains it.
 */

export const VERSIONS_KEPT = 10;

export const versionsId = (planId: string) => `av_${planId}`;

export interface VersionDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const isBlogHub = (node: ContentNode | undefined): node is ContentNode => Boolean(node && node.type === "hub" && node.channel === "blog");

/** The version a node's copy makes, without its number. */
function versionOf(node: ContentNode, reason: VersionReason, byUid: string | null, at: string): Omit<ArticleVersion, "n"> {
  const blog = node.blog;
  return {
    at,
    reason,
    byUid,
    body: node.body,
    metaTitle: blog?.metaTitle ?? "",
    metaDescription: blog?.metaDescription ?? "",
    slug: blog?.slug ?? "",
    checkedAt: blog?.checkedAt ?? null,
    updated: blog?.dates?.updated ?? null,
  };
}

/**
 * Keep the article's copy as it is now, before something replaces it. Nothing is kept for an
 * article with no copy yet, or when the switch is off. Returns the version's number, or null.
 */
export async function saveVersion(
  ctx: TenantContext,
  args: { plan: Pick<ContentPlan, "id" | "workspaceId">; node: ContentNode | undefined; reason: VersionReason },
  deps: VersionDeps = {},
): Promise<number | null> {
  if (!isBlogRefreshEnabled()) return null;
  const { plan, node, reason } = args;
  if (!isBlogHub(node) || !node.body.trim()) return null;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const version = versionOf(node, reason, ctx.userId ?? null, at);
  const { doc } = await forTenant(ctx, deps.db).articleVersions.upsert(
    versionsId(plan.id),
    () => ({ planId: plan.id, workspaceId: plan.workspaceId, next: 2, versions: [{ n: 1, ...version }], updatedAt: at }),
    (current) => {
      // The same copy kept twice in a row says nothing new: keep the one already there.
      if (current.versions[0]?.body === version.body && current.versions[0]?.metaTitle === version.metaTitle) return null;
      const n = current.next;
      return { next: n + 1, versions: [{ n, ...version }, ...current.versions].slice(0, VERSIONS_KEPT), updatedAt: at };
    },
  );
  return doc.versions[0]?.n ?? null;
}

/** What the Versions list shows: each version without its copy, newest first. */
export interface VersionListing {
  n: number;
  at: string;
  reason: VersionReason;
  words: number;
  metaTitle: string;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

export async function listVersions(ctx: TenantContext, planId: string, deps: VersionDeps = {}): Promise<VersionListing[]> {
  const doc = await readVersions(ctx, planId, deps);
  return (doc?.versions ?? []).map((v) => ({ n: v.n, at: v.at, reason: v.reason, words: wordCount(v.body), metaTitle: v.metaTitle }));
}

export async function readVersions(ctx: TenantContext, planId: string, deps: VersionDeps = {}): Promise<ArticleVersionsDoc | null> {
  return forTenant(ctx, deps.db).articleVersions.getById(versionsId(planId)).catch(() => null);
}

export type RestoreResult = { ok: true; node: ContentNode; kept: number | null } | { ok: false; error: "not_found" | "no_version" | "locked" };

/**
 * Put version `n` back: its copy, its meta and its Updated. The copy it replaces is kept first.
 * The article goes back to "generated", so a person approves it again; the live mark, the hero,
 * Published and the freshness clock stay as they are.
 */
export async function restoreVersion(
  ctx: TenantContext,
  args: { plan: ContentPlan; nodeId: string; n: number },
  deps: VersionDeps = {},
): Promise<RestoreResult> {
  const { plan, nodeId, n } = args;
  const node = plan.graph.nodes.find((x) => x.id === nodeId);
  if (!isBlogHub(node)) return { ok: false, error: "not_found" };
  // Scheduled copy is a person's decision, as the fact check treats it.
  if (node.distributionStatus || node.scheduledAt) return { ok: false, error: "locked" };
  const doc = await readVersions(ctx, plan.id, deps);
  const version = doc?.workspaceId === plan.workspaceId ? doc.versions.find((v) => v.n === n) : undefined;
  if (!version) return { ok: false, error: "no_version" };

  const kept = await saveVersion(ctx, { plan, node, reason: "restore" }, deps);
  const blog = BlogArticleMetaSchema.parse({
    ...(node.blog ?? {}),
    metaTitle: version.metaTitle,
    metaDescription: version.metaDescription,
    slug: version.slug,
    checkedAt: version.checkedAt,
    corrections: [],
    unsupportedFigures: [],
    removedLinks: [],
  });
  const updated = await updateContentPlanNode(ctx, plan.workspaceId, plan.id, nodeId, { body: version.body, status: "generated", blog, made: { unstamped: "person_restored" } }, deps.db, {
    // Updated as it was with that copy; Published and the page's own dates stay.
    setDates: (stored) => {
      if (!stored) return stored;
      const { updated: _now, ...rest } = stored;
      void _now;
      return version.updated ? { ...rest, updated: version.updated } : rest;
    },
  });
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, node: updated, kept };
}
