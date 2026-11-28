import { createHash } from "node:crypto";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { markTranslationsQueued, takeTranslationCall } from "@/lib/tenant/translations";
import { authorOf } from "@/lib/content/blog/draft";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { articleTranslationIdOf, isArticleTranslation, type ArticleTranslation, type ArticleWords } from "@/lib/types/translation";
import { articleLanguages } from "./assetLanguages";
import { isPageLanguagesEnabled } from "./flags";
import { brandLanguages, languageReaders, minReadersOf } from "./languageReaders";
import { DEFAULT_LOCALE, normalizeLocale } from "./locale";
import { cleanSiteAddresses, versionAddressOf } from "./siteAddresses";
import { ARTICLE_TRANSLATE_TIMEOUT_MS, translateArticle, type ArticleTranslateInput, type ArticleTranslateResult } from "./translateArticle";
import { translationUsage } from "./translate";

/**
 * An article's versions in other languages (PAGE_LANGUAGES_ENABLED), as records in `translations`
 * (kind "article"). This file holds what the content plan routes call.
 */

/** A deleted plan's article versions go with it, switch on or off. A failure is logged, never thrown. */
export async function forgetPlanTranslations(ctx: TenantContext, planId: string, db?: FirestoreLike): Promise<void> {
  try {
    await forTenant(ctx, db).translations.deleteWhere([["planId", "==", planId]]);
  } catch (err) {
    console.warn(`[translations] removing plan ${planId}'s versions failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

// ---- Queueing on approval, and making one ---------------------------------------------------------



const iso = (ms: number) => new Date(ms).toISOString();

/** An article is long: a run holds it this long. */
export const ARTICLE_LEASE_MS = 2 * ARTICLE_TRANSLATE_TIMEOUT_MS;

/** Is this node a blog article (the plan's blog hub)? */
export function isBlogArticle(plan: Pick<ContentPlan, "topology">, node: Pick<ContentNode, "type" | "channel">): boolean {
  return plan.topology.hubChannel === "blog" && node.type === "hub" && node.channel === "blog";
}

/** The words of an article that are translated. */
export function articleWordsOf(node: Pick<ContentNode, "body" | "blog">): ArticleWords {
  return {
    metaTitle: node.blog?.metaTitle ?? "",
    metaDescription: node.blog?.metaDescription ?? "",
    heroAlt: node.blog?.hero?.alt ?? "",
    body: node.body,
  };
}

/** A short hash of an article's words, to tell whether a version still matches them. */
export function articleWordsHash(w: ArticleWords): string {
  return createHash("sha256").update([w.metaTitle, w.metaDescription, w.heroAlt, w.body].join("\u0000")).digest("hex").slice(0, 16);
}

/** The brand's default language: an article is written in it (piece 0). */
const baseOf = (tenant: Tenant | null) => normalizeLocale(tenant?.defaultLocale) ?? DEFAULT_LOCALE;

/**
 * Queue an approved article's versions (PAGE_LANGUAGES_ENABLED): each of its languages whose words
 * changed since its version was made, plus `extra` (Make anyway, Update now, Try again). Each record
 * keeps the approved words, so later edits can't change what is translated. Marks the brand for the
 * lane. Nothing for an article that isn't approved, or a brand with one language. Returns how many.
 */
export async function queueArticleTranslations(
  ctx: TenantContext,
  args: { workspaceId: string; plan: ContentPlan; node: ContentNode; tenant?: Tenant | null; extra?: readonly string[]; nowMs?: number },
  db?: FirestoreLike,
): Promise<number> {
  if (!isPageLanguagesEnabled()) return 0;
  const { plan, node } = args;
  if (!isBlogArticle(plan, node) || node.status !== "approved" || !node.body.trim()) return 0;
  const tenant = args.tenant !== undefined ? args.tenant : await getTenantById(ctx.tenantId, db).catch(() => null);
  const list = brandLanguages(tenant);
  if (list.length < 2) return 0;
  const nowMs = args.nowMs ?? Date.now();
  const base = baseOf(tenant);
  const sites = cleanSiteAddresses(tenant?.languageSettings?.siteAddresses, list, base);
  const counted = plan.topology.languages ? null : await languageReaders(ctx, tenant, { db, now: () => nowMs });
  const asked = (args.extra ?? []).filter((c) => c !== base && list.includes(c));
  // The article's own languages, then any a person asked for now (Make anyway, Update now, Try again).
  const own = articleLanguages({ base, list, minReaders: minReadersOf(tenant), readers: counted?.readers ?? null, sites, chosen: plan.topology.languages });
  const wanted = [...new Set([...own, ...asked])];
  const repo = forTenant(ctx, db);
  const existing = (await repo.translations.find({ where: [["planId", "==", plan.id]] })).filter(isArticleTranslation).filter((t) => t.nodeId === node.id);
  const words = articleWordsOf(node);
  const hash = articleWordsHash(words);
  const brief = plan.blog;
  const author = brief && authorOf(brief).name ? { name: authorOf(brief).name, role: authorOf(brief).role || null } : null;
  const glossary = [tenant?.tenantName ?? "", brief?.publisherName ?? "", ...(brief?.entities ?? []).filter((e) => e.relation === "product").map((e) => e.name)]
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 20);
  let queued = 0;
  for (const lang of new Set([...wanted, ...existing.map((t) => t.lang)])) {
    const id = articleTranslationIdOf(plan.id, node.id, lang);
    const doc = existing.find((t) => t.id === id);
    const askedNow = asked.includes(lang);
    // Made from these words already: nothing to do, unless it failed and a person asks again (Try again).
    if (doc && doc.sourceHash === hash && doc.from === base && !(doc.state === "failed" && askedNow)) continue;
    const at = iso(nowMs);
    await repo.translations.upsert(
      id,
      () => ({
        kind: "article" as const,
        workspaceId: args.workspaceId,
        planId: plan.id,
        nodeId: node.id,
        lang,
        from: base,
        state: "queued" as const,
        rev: 0,
        sourceHash: hash,
        source: words,
        draft: null,
        approved: null,
        failReason: null,
        leaseUntil: null,
        address: versionAddressOf(sites[lang], node.blog?.slug),
        live: null,
        author,
        glossary,
        ...(askedNow && !own.includes(lang) ? { anyway: true } : {}),
        createdAt: at,
        updatedAt: at,
      }),
      (cur) => (isArticleTranslation(cur) ? { state: "queued", source: words, sourceHash: hash, from: base, author, glossary, failReason: null, leaseUntil: null, rev: cur.rev + 1, updatedAt: at } : null),
    );
    queued += 1;
  }
  if (queued) await markTranslationsQueued(ctx.tenantId, iso(nowMs), db).catch(() => {});
  return queued;
}

/**
 * Queue the versions of every approved article in a plan (the content plan save's hook). Each is
 * queued only when its words changed, so a save that changed nothing costs no write. Never throws.
 */
export async function queuePlanArticles(ctx: TenantContext, args: { workspaceId: string; plan: ContentPlan | null }, db?: FirestoreLike): Promise<void> {
  if (!isPageLanguagesEnabled() || !args.plan) return;
  const plan = args.plan;
  for (const node of plan.graph.nodes) {
    if (!isBlogArticle(plan, node) || node.status !== "approved") continue;
    await queueArticleTranslations(ctx, { workspaceId: args.workspaceId, plan, node }, db).catch((err) =>
      console.warn(`[translations] queueing article ${plan.id} failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error"),
    );
  }
}

export type ArticleOutcome = "made" | "failed" | "capped" | "busy";

/**
 * Make one queued article version: hold it, take a call from the brand's day, translate the words
 * it was queued with, and keep the draft for a person to check (or the reason it failed).
 */
export async function translateArticleOne(
  ctx: TenantContext,
  tenant: Tenant,
  id: string,
  opts: { db?: FirestoreLike; nowMs: number; deadlineMs: number; dailyCap: number; translate?: (input: ArticleTranslateInput) => Promise<ArticleTranslateResult> },
): Promise<ArticleOutcome> {
  const repo = forTenant(ctx, opts.db);
  const now = iso(opts.nowMs);
  const lease = iso(opts.nowMs + ARTICLE_LEASE_MS);
  const held = await repo.translations.claim(id, (cur) =>
    cur.kind === "article" && cur.state === "queued" && !(cur.leaseUntil && cur.leaseUntil > now) ? { leaseUntil: lease } : null,
  );
  if (!held || !isArticleTranslation(held)) return "busy";
  if (!(await takeTranslationCall(ctx.tenantId, now.slice(0, 10), opts.dailyCap, opts.db))) {
    await repo.translations.claim(id, (cur) => (cur.leaseUntil === lease ? { leaseUntil: null } : null)).catch(() => null);
    return "capped";
  }
  const res = await (opts.translate ?? translateArticle)({
    words: held.source,
    from: held.from,
    to: held.lang,
    glossary: held.glossary ?? [tenant.tenantName],
    author: held.author ?? null,
    note: tenant.languageSettings?.translatedNote === true,
    usage: translationUsage(ctx, tenant),
    deadlineMs: opts.deadlineMs,
  });
  const at = iso(opts.nowMs);
  const written = await repo.translations.claim(id, (cur) => {
    if (cur.leaseUntil !== lease || !isArticleTranslation(cur)) return null;
    const common = { leaseUntil: null, rev: cur.rev + 1, updatedAt: at };
    return res.ok
      ? { ...common, state: "to_check" as const, failReason: null, draft: { fields: res.fields, sourceHash: cur.sourceHash, by: "ai" as const, at } }
      : { ...common, state: "failed" as const, failReason: res.reason.slice(0, 300) };
  });
  if (!written) return "busy";
  return res.ok ? "made" : "failed";
}

export type { ArticleTranslation };
