import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BlogBrief } from "@/lib/types/contentPlan";
import { fold } from "@/lib/brandMap/changes";
import { isBlogEditorialEnabled } from "./flags";

/**
 * An author's role, bio and profile page, kept per brand (CREATE_BLOG_EDITORIAL_ENABLED) so a
 * person types them once: research fills them into the next article by that author, and only
 * into fields left empty. Best effort: a failed read or write never stops research or a check.
 */

export function authorDocId(tenantId: string, name: string): string {
  return `au_${createHash("sha256").update(`${tenantId}\n${fold(name)}`).digest("hex").slice(0, 40)}`;
}

/** Keep the brief's author details for next time (a name and at least one of role, bio, page). */
export async function rememberAuthor(ctx: TenantContext, brief: BlogBrief, db?: FirestoreLike, now = new Date()): Promise<void> {
  if (!isBlogEditorialEnabled()) return;
  const name = brief.author.replace(/\s+/g, " ").trim().slice(0, 120);
  const role = (brief.authorRole ?? "").trim().slice(0, 120);
  const bio = (brief.authorBio ?? "").trim().slice(0, 600);
  const url = (brief.authorUrl ?? "").trim().slice(0, 2000);
  if (!name || !(role || bio || url)) return;
  const fields = { name, role, bio, url, updatedAt: now.toISOString() };
  await forTenant(ctx, db)
    .brandAuthors.upsert(authorDocId(ctx.tenantId, name), () => fields, (current) =>
      current.role === role && current.bio === bio && current.url === url && current.name === name ? null : fields,
    )
    .catch((err) => console.error("[blog] keeping the author failed", err));
}

/** The brief with the author's kept details filled into whichever of role, bio and page are empty. */
export async function withRememberedAuthor(ctx: TenantContext, brief: BlogBrief, db?: FirestoreLike): Promise<BlogBrief> {
  if (!isBlogEditorialEnabled()) return brief;
  const name = brief.author.trim();
  const empty = (v: string | undefined) => !(v ?? "").trim();
  if (!name || !(empty(brief.authorRole) || empty(brief.authorBio) || empty(brief.authorUrl))) return brief;
  const kept = await forTenant(ctx, db)
    .brandAuthors.getById(authorDocId(ctx.tenantId, name))
    .catch(() => null);
  if (!kept) return brief;
  return {
    ...brief,
    ...(empty(brief.authorRole) && kept.role ? { authorRole: kept.role } : {}),
    ...(empty(brief.authorBio) && kept.bio ? { authorBio: kept.bio } : {}),
    ...(empty(brief.authorUrl) && /^https:\/\//.test(kept.url) ? { authorUrl: kept.url } : {}),
  };
}
