import { createHash } from "node:crypto";
import { z } from "zod";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { markTranslationsQueued, takeTranslationCall } from "@/lib/tenant/translations";
import { authorOf } from "@/lib/content/blog/draft";
import { articleAddressProblem } from "@/lib/content/blog/address";
import { wakeLiveWatch } from "@/lib/content/blog/liveWatchWake";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { ArticleWordsSchema, articleTranslationIdOf, isArticleTranslation, type ArticleTranslation, type ArticleWords } from "@/lib/types/translation";
import { articleLanguages } from "./assetLanguages";
import { isPageLanguagesEnabled } from "./flags";
import { brandLanguages, languageReaders, minReadersOf } from "./languageReaders";
import { DEFAULT_LOCALE, languageName, localeInfo, normalizeLocale } from "./locale";
import { cleanSiteAddresses, versionAddressOf } from "./siteAddresses";
import { ARTICLE_TRANSLATE_TIMEOUT_MS, translateArticle, type ArticleTranslateInput, type ArticleTranslateResult } from "./translateArticle";
import { linksOf, translationUsage } from "./translate";

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

// ---- The article's language tabs and Article › Languages: the view and a person's actions ----------

/** What a version's tab and row show, worked out here where the words are hashed. */
export type ArticleTabState = "not_made" | "waiting" | "translating" | "to_check" | "approved" | "changed" | "out_of_date" | "failed";

export interface ArticleVersionView {
  lang: string;
  name: string;
  nativeName: string;
  state: ArticleTabState;
  id: string;
  rev: number | null;
  readers: number | null;
  ready: boolean;
  /** The language's site folder, when Settings has one. */
  folder: string | null;
  address: string | null;
  draft: ArticleTranslation["draft"];
  approved: ArticleTranslation["approved"];
  live: ArticleTranslation["live"];
  failReason: string | null;
}

export interface ArticleTranslationsView {
  allowed: boolean;
  base: { code: string; name: string; nativeName: string; address: string | null };
  minReaders: number;
  approved: boolean;
  versions: ArticleVersionView[];
}

type Result = { status: number; body: unknown };
const ok = (body: unknown): Result => ({ status: 200, body });
const fail = (status: number, error: string): Result => ({ status, body: { error } });

async function loadArticle(ctx: TenantContext, workspaceId: string, planId: string, db?: FirestoreLike) {
  const plan = await getContentPlan(ctx, workspaceId, planId, db).catch(() => null);
  const node = plan?.graph.nodes.find((n) => isBlogArticle(plan, n)) ?? null;
  return plan && node ? { plan, node } : null;
}

function articleStateOf(t: ArticleTranslation | undefined, node: ContentNode, wanted: boolean, hash: string): ArticleTabState {
  if (!t) return wanted && node.status === "approved" ? "waiting" : "not_made";
  if (t.state === "queued") return "translating";
  if (t.state === "failed") return "failed";
  if (t.state === "to_check") return "to_check";
  if (t.approved && t.approved.sourceHash !== hash) return node.status === "approved" ? "out_of_date" : "changed";
  return "approved";
}

/** The article's versions, one per language other than the default, with what each can do. */
export async function articleTranslationsView(ctx: TenantContext, workspaceId: string, planId: string, db?: FirestoreLike, now: () => number = Date.now): Promise<Result> {
  if (!isPageLanguagesEnabled()) return fail(503, "page_languages_disabled");
  const found = await loadArticle(ctx, workspaceId, planId, db);
  if (!found) return fail(404, "not_found");
  const { plan, node } = found;
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  const list = brandLanguages(tenant);
  const base = baseOf(tenant);
  const sites = cleanSiteAddresses(tenant?.languageSettings?.siteAddresses, list, base);
  const counted = await languageReaders(ctx, tenant, { db, now });
  const minReaders = minReadersOf(tenant);
  const own = articleLanguages({ base, list, minReaders, readers: counted?.readers ?? null, sites, chosen: plan.topology.languages });
  const docs = new Map((await forTenant(ctx, db).translations.find({ where: [["planId", "==", planId]] })).filter(isArticleTranslation).map((t) => [t.lang, t]));
  const hash = articleWordsHash(articleWordsOf(node));
  const versions = list
    .filter((c) => c !== base)
    .map((lang): ArticleVersionView => {
      const t = docs.get(lang);
      const readers = counted?.readers[lang] ?? null;
      return {
        lang,
        name: languageName(lang),
        nativeName: localeInfo(lang).nativeName,
        state: articleStateOf(t, node, own.includes(lang), hash),
        id: articleTranslationIdOf(plan.id, node.id, lang),
        rev: t?.rev ?? null,
        readers,
        ready: readers !== null && readers >= minReaders,
        folder: sites[lang] ?? null,
        address: t?.address ?? versionAddressOf(sites[lang], node.blog?.slug),
        draft: t?.draft ?? null,
        approved: t?.approved ?? null,
        live: t?.live ?? null,
        failReason: t?.failReason ?? null,
      };
    });
  const view: ArticleTranslationsView = {
    allowed: tenantMayUse(tenant, "translations"),
    base: { code: base, name: languageName(base), nativeName: localeInfo(base).nativeName, address: plan.strategy.hubUrl?.trim() || null },
    minReaders,
    approved: node.status === "approved",
    versions,
  };
  return ok(view);
}

const ArticleRev = z.number().int().nonnegative();
const ArticleActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), id: z.string().min(1).max(300), rev: ArticleRev }),
  z.object({ action: z.literal("approve_all"), revs: z.record(z.string().max(300), ArticleRev).refine((r) => Object.keys(r).length <= 30) }),
  z.object({ action: z.literal("save"), id: z.string().min(1).max(300), rev: ArticleRev, fields: ArticleWordsSchema }),
  z.object({ action: z.literal("address"), id: z.string().min(1).max(300), address: z.string().trim().max(2000) }),
  z.object({ action: z.literal("make"), lang: z.string().min(2).max(10) }),
]);
const ARTICLE_RATE = { prefix: "article_translations_make", burstLimit: 10, hourlyLimit: 60 };

/** Approve one version a person saw at `rev`, made from the article's words as approved now. */
async function approveArticleOne(ctx: TenantContext, id: string, rev: number, hash: string, db?: FirestoreLike): Promise<"approved" | "moved" | "out_of_date"> {
  let outcome: "approved" | "moved" | "out_of_date" = "moved";
  const at = new Date().toISOString();
  await forTenant(ctx, db).translations.claim(id, (cur) => {
    if (!isArticleTranslation(cur) || cur.rev !== rev || cur.state !== "to_check" || !cur.draft) return null;
    if (cur.draft.sourceHash !== hash) {
      outcome = "out_of_date";
      return null;
    }
    outcome = "approved";
    return { state: "approved", approved: { ...cur.draft, from: cur.from, approvedBy: ctx.userId ?? ctx.email ?? "admin", approvedAt: at }, draft: null, rev: cur.rev + 1, updatedAt: at };
  });
  return outcome;
}

/** What an admin does on a version: approve one or all, save their own words, set its address, or make it. */
export async function articleTranslationsAction(ctx: TenantContext, workspaceId: string, planId: string, input: unknown, db?: FirestoreLike): Promise<Result> {
  if (!isPageLanguagesEnabled()) return fail(503, "page_languages_disabled");
  const parsed = ArticleActionInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input");
  const found = await loadArticle(ctx, workspaceId, planId, db);
  if (!found) return fail(404, "not_found");
  const { plan, node } = found;
  const repo = forTenant(ctx, db);
  const hash = articleWordsHash(articleWordsOf(node));
  const a = parsed.data;
  const mine = async (id: string) => {
    const doc = await repo.translations.getById(id);
    return doc && isArticleTranslation(doc) && doc.planId === planId ? doc : null;
  };

  if (a.action === "approve" || a.action === "approve_all") {
    if (node.status !== "approved") return fail(409, "article_not_approved");
    const revs = a.action === "approve" ? { [a.id]: a.rev } : a.revs;
    let approved = 0;
    let skipped = 0;
    let last: "approved" | "moved" | "out_of_date" = "moved";
    for (const [id, rev] of Object.entries(revs)) {
      last = (await mine(id)) ? await approveArticleOne(ctx, id, rev, hash, db) : "moved";
      if (last === "approved") approved += 1;
      else skipped += 1;
    }
    if (approved) await wakeLiveWatch(ctx, { db }).catch(() => {});
    if (a.action === "approve") return approved ? ok({ approved }) : fail(409, last === "out_of_date" ? "out_of_date" : "changed");
    return ok({ approved, skipped });
  }

  if (a.action === "save") {
    const doc = await mine(a.id);
    if (!doc) return fail(404, "not_found");
    if (!a.fields.metaTitle.trim() || !a.fields.body.trim()) return fail(400, "empty");
    // A person's own words keep every link of the article: a version links where the original does.
    const outward = (b: string) => linksOf(b).filter((l) => !l.startsWith("#")).sort().join("\n");
    if (outward(doc.source.body) !== outward(a.fields.body)) return fail(400, "links_changed");
    const at = new Date().toISOString();
    let moved = false;
    await repo.translations.claim(a.id, (cur) => {
      if (!isArticleTranslation(cur) || cur.rev !== a.rev || cur.state === "queued") {
        moved = true;
        return null;
      }
      return { state: "to_check", draft: { fields: a.fields, sourceHash: cur.sourceHash, by: "person", at }, failReason: null, rev: cur.rev + 1, updatedAt: at };
    });
    return moved ? fail(409, "changed") : ok({ saved: true });
  }

  if (a.action === "address") {
    const doc = await mine(a.id);
    if (!doc) return fail(404, "not_found");
    if (a.address && articleAddressProblem(a.address)) return fail(400, "invalid_address");
    await repo.translations.claim(a.id, (cur) => (isArticleTranslation(cur) ? { address: a.address || null, live: null, rev: cur.rev + 1, updatedAt: new Date().toISOString() } : null));
    await wakeLiveWatch(ctx, { db }).catch(() => {});
    return ok({ address: a.address || null });
  }

  // make: Make anyway, Update now or Try again for one language.
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  if (!tenantMayUse(tenant, "translations")) return fail(403, "not_included");
  if (node.status !== "approved") return fail(409, "article_not_approved");
  const list = brandLanguages(tenant);
  if (a.lang === baseOf(tenant) || !list.includes(a.lang)) return fail(400, "not_in_your_languages");
  if (await isRateLimited(`${ctx.tenantId}:${ctx.userId ?? "admin"}`, ARTICLE_RATE, { db })) return fail(429, "rate_limited");
  const queued = await queueArticleTranslations(ctx, { workspaceId, plan, node, tenant, extra: [a.lang] }, db);
  return ok({ queued });
}
