import { createHash } from "node:crypto";
import { z } from "zod";
import { forTenant, getTenantById } from "@/lib/tenant";
import { markTranslationsQueued, takeTranslationCall } from "@/lib/tenant/translations";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { resolveProductName, type Campaign } from "@/lib/types/campaign";
import type { Tenant } from "@/lib/types/tenant";
import { LaunchWordsSchema, isLaunchCopyTranslation, launchTranslationIdOf, type LaunchCopyTranslation, type LaunchWords } from "@/lib/types/translation";
import { isPageLanguagesEnabled } from "./flags";
import { DEFAULT_LOCALE, languageName, localeInfo, normalizeLocale, resolveCampaignLocale, supportedLocalesFor } from "./locale";
import { tokensOf, translationUsage, TRANSLATE_TIMEOUT_MS } from "./translate";
import { translateLaunch, type LaunchTranslateInput, type LaunchTranslateResult } from "./translateLaunch";
import { hasWidgetWords } from "./widgetLocales";

/**
 * A launch page's own words in other languages (PAGE_LANGUAGES_ENABLED), as `translations` records
 * of kind "launch_copy": queued when the launch is saved, made by the translations lane, checked on
 * the launch's language tabs, and shown on its page at /waitlist/<id>/<lang> once approved.
 */

const iso = (ms: number) => new Date(ms).toISOString();

/** The words on a launch page that the brand wrote. */
export function launchWordsOf(c: Pick<Campaign, "waitlistName" | "configurationStyleJson" | "aiConversation" | "questions">): LaunchWords {
  return {
    waitlistName: c.waitlistName ?? "",
    statusDescription: c.configurationStyleJson?.statusDescription?.trim() || null,
    joinButtonLabel: c.configurationStyleJson?.joinButtonLabel?.trim() || null,
    introLine: c.aiConversation?.introLine?.trim() || null,
    questions: (c.questions ?? []).map((q) => ({ question: q.question_value, answers: q.answer_value ?? null })),
  };
}

export function launchWordsHash(w: LaunchWords): string {
  return createHash("sha256").update(JSON.stringify(w)).digest("hex").slice(0, 16);
}

/** The launch's own language: its page at /waitlist/<id> is in it. */
export function launchBaseOf(c: Campaign, tenant: Tenant | null): string {
  return normalizeLocale(resolveCampaignLocale(c, tenant)) ?? DEFAULT_LOCALE;
}

/** The languages a launch page has its own address in: offered, with the widget's words, not its own. */
export function launchLanguages(c: Campaign, tenant: Tenant | null): string[] {
  const base = launchBaseOf(c, tenant);
  return supportedLocalesFor(c, tenant).filter((code) => code !== base && hasWidgetWords(code));
}

/**
 * Queue a launch's words for each of its languages when they changed since its translation was
 * made (and `extra`: Try again). Marks the brand for the lane. Returns how many.
 */
export async function queueLaunchTranslations(
  ctx: TenantContext,
  args: { campaign: Campaign; tenant?: Tenant | null; extra?: readonly string[]; nowMs?: number },
  db?: FirestoreLike,
): Promise<number> {
  if (!isPageLanguagesEnabled()) return 0;
  const { campaign } = args;
  const tenant = args.tenant !== undefined ? args.tenant : await getTenantById(ctx.tenantId, db).catch(() => null);
  const langs = launchLanguages(campaign, tenant);
  if (!langs.length || !campaign.waitlistName?.trim()) return 0;
  const nowMs = args.nowMs ?? Date.now();
  const base = launchBaseOf(campaign, tenant);
  const words = launchWordsOf(campaign);
  const hash = launchWordsHash(words);
  const repo = forTenant(ctx, db);
  const existing = (await repo.translations.find({ where: [["campaignId", "==", campaign.id]] })).filter(isLaunchCopyTranslation);
  const asked = (args.extra ?? []).filter((c) => langs.includes(c));
  let queued = 0;
  for (const lang of langs) {
    const id = launchTranslationIdOf(campaign.id, lang);
    const doc = existing.find((t) => t.id === id);
    if (doc && doc.sourceHash === hash && doc.from === base && !(doc.state === "failed" && asked.includes(lang))) continue;
    const at = iso(nowMs);
    await repo.translations.upsert(
      id,
      () => ({
        kind: "launch_copy" as const,
        campaignId: campaign.id,
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
        createdAt: at,
        updatedAt: at,
      }),
      (cur) => (isLaunchCopyTranslation(cur) ? { state: "queued", source: words, sourceHash: hash, from: base, failReason: null, leaseUntil: null, rev: cur.rev + 1, updatedAt: at } : null),
    );
    queued += 1;
  }
  if (queued) await markTranslationsQueued(ctx.tenantId, iso(nowMs), db).catch(() => {});
  return queued;
}

/** The launch save's hook: never throws. */
export async function queueLaunchSoftly(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<void> {
  if (!isPageLanguagesEnabled()) return;
  try {
    const campaign = await forTenant(ctx, db).campaigns.getById(campaignId);
    if (campaign) await queueLaunchTranslations(ctx, { campaign }, db);
  } catch (err) {
    console.warn(`[translations] queueing launch ${campaignId} failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

export const LAUNCH_LEASE_MS = 2 * TRANSLATE_TIMEOUT_MS;

/** Make one queued launch translation (the translations lane). */
export async function translateLaunchOne(
  ctx: TenantContext,
  tenant: Tenant,
  id: string,
  opts: { db?: FirestoreLike; nowMs: number; dailyCap: number; translate?: (input: LaunchTranslateInput) => Promise<LaunchTranslateResult> },
): Promise<"made" | "failed" | "capped" | "busy"> {
  const repo = forTenant(ctx, opts.db);
  const now = iso(opts.nowMs);
  const lease = iso(opts.nowMs + LAUNCH_LEASE_MS);
  const held = await repo.translations.claim(id, (cur) =>
    cur.kind === "launch_copy" && cur.state === "queued" && !(cur.leaseUntil && cur.leaseUntil > now) ? { leaseUntil: lease } : null,
  );
  if (!held || !isLaunchCopyTranslation(held)) return "busy";
  if (!(await takeTranslationCall(ctx.tenantId, now.slice(0, 10), opts.dailyCap, opts.db))) {
    await repo.translations.claim(id, (cur) => (cur.leaseUntil === lease ? { leaseUntil: null } : null)).catch(() => null);
    return "capped";
  }
  const campaign = await repo.campaigns.getById(held.campaignId).catch(() => null);
  const glossary = [tenant.tenantName, campaign ? resolveProductName(campaign) : ""].filter(Boolean);
  const res = await (opts.translate ?? translateLaunch)({ words: held.source, from: held.from, to: held.lang, glossary, usage: translationUsage(ctx, tenant) });
  const at = iso(opts.nowMs);
  const written = await repo.translations.claim(id, (cur) => {
    if (cur.leaseUntil !== lease || !isLaunchCopyTranslation(cur)) return null;
    const common = { leaseUntil: null, rev: cur.rev + 1, updatedAt: at };
    return res.ok
      ? { ...common, state: "to_check" as const, failReason: null, draft: { fields: res.fields, sourceHash: cur.sourceHash, by: "ai" as const, at } }
      : { ...common, state: "failed" as const, failReason: res.reason.slice(0, 300) };
  });
  if (!written) return "busy";
  // What made it (LOOPS_ENABLED, learning loops step 5): counted made once its draft is kept, as a
  // journey email's is, with no stamp on the record yet and no type, as it is part of its launch.
  if (res.ok) await countMade(ctx, "translation", (await learnedFor(ctx, "translation", { promptId: "i18n.translate_launch" })).stamp, { db: opts.db });
  return res.ok ? "made" : "failed";
}

/** A launch page's approved words in `lang`, from its current language; null when there are none. */
export async function approvedLaunchWords(ctx: TenantContext, campaign: Campaign, tenant: Tenant | null, lang: string, db?: FirestoreLike): Promise<LaunchWords | null> {
  if (!isPageLanguagesEnabled()) return null;
  const doc = await forTenant(ctx, db).translations.getById(launchTranslationIdOf(campaign.id, lang)).catch(() => null);
  if (!doc || !isLaunchCopyTranslation(doc) || !doc.approved || doc.approved.from !== launchBaseOf(campaign, tenant)) return null;
  return doc.approved.fields;
}

/** Each language with approved words for this launch (for its page's language tags). */
export async function approvedLaunchLanguages(ctx: TenantContext, campaign: Campaign, tenant: Tenant | null, db?: FirestoreLike): Promise<string[]> {
  if (!isPageLanguagesEnabled()) return [];
  const base = launchBaseOf(campaign, tenant);
  const offered = launchLanguages(campaign, tenant);
  const docs = (await forTenant(ctx, db).translations.find({ where: [["campaignId", "==", campaign.id]] }).catch(() => [])).filter(isLaunchCopyTranslation);
  return docs.filter((t) => offered.includes(t.lang) && t.approved && t.approved.from === base).map((t) => t.lang);
}

// ---- The launch's language tabs: the view and a person's actions -------------------------------------

export type LaunchTabState = "translating" | "to_check" | "approved" | "changed" | "failed" | "not_made";

export interface LaunchVersionView {
  lang: string;
  name: string;
  nativeName: string;
  state: LaunchTabState;
  id: string;
  rev: number | null;
  draft: LaunchCopyTranslation["draft"];
  approved: LaunchCopyTranslation["approved"];
  failReason: string | null;
}

export interface LaunchTranslationsView {
  allowed: boolean;
  base: { code: string; name: string; nativeName: string };
  versions: LaunchVersionView[];
}

type Result = { status: number; body: unknown };
const ok = (body: unknown): Result => ({ status: 200, body });
const fail = (status: number, error: string): Result => ({ status, body: { error } });

function launchStateOf(t: LaunchCopyTranslation | undefined, hash: string): LaunchTabState {
  if (!t) return "not_made";
  if (t.state === "queued") return "translating";
  if (t.state === "failed") return "failed";
  if (t.state === "to_check") return "to_check";
  return t.approved && t.approved.sourceHash !== hash ? "changed" : "approved";
}

export async function launchTranslationsView(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<Result> {
  if (!isPageLanguagesEnabled()) return fail(503, "page_languages_disabled");
  const campaign = await forTenant(ctx, db).campaigns.getById(campaignId).catch(() => null);
  if (!campaign) return fail(404, "not_found");
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  const base = launchBaseOf(campaign, tenant);
  const hash = launchWordsHash(launchWordsOf(campaign));
  const docs = new Map((await forTenant(ctx, db).translations.find({ where: [["campaignId", "==", campaignId]] })).filter(isLaunchCopyTranslation).map((t) => [t.lang, t]));
  const view: LaunchTranslationsView = {
    allowed: tenantMayUse(tenant, "translations"),
    base: { code: base, name: languageName(base), nativeName: localeInfo(base).nativeName },
    versions: launchLanguages(campaign, tenant).map((lang) => {
      const t = docs.get(lang);
      return {
        lang,
        name: languageName(lang),
        nativeName: localeInfo(lang).nativeName,
        state: launchStateOf(t, hash),
        id: launchTranslationIdOf(campaignId, lang),
        rev: t?.rev ?? null,
        draft: t?.draft ?? null,
        approved: t?.approved ?? null,
        failReason: t?.failReason ?? null,
      };
    }),
  };
  return ok(view);
}

const Rev = z.number().int().nonnegative();
const LaunchActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), id: z.string().min(1).max(300), rev: Rev }),
  z.object({ action: z.literal("approve_all"), revs: z.record(z.string().max(300), Rev).refine((r) => Object.keys(r).length <= 10) }),
  z.object({ action: z.literal("save"), id: z.string().min(1).max(300), rev: Rev, fields: LaunchWordsSchema }),
  z.object({ action: z.literal("make"), lang: z.string().min(2).max(10) }),
]);
const RATE = { prefix: "launch_translations_make", burstLimit: 10, hourlyLimit: 60 };

export async function launchTranslationsAction(ctx: TenantContext, campaignId: string, input: unknown, db?: FirestoreLike): Promise<Result> {
  if (!isPageLanguagesEnabled()) return fail(503, "page_languages_disabled");
  const parsed = LaunchActionInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input");
  const repo = forTenant(ctx, db);
  const campaign = await repo.campaigns.getById(campaignId).catch(() => null);
  if (!campaign) return fail(404, "not_found");
  const hash = launchWordsHash(launchWordsOf(campaign));
  const a = parsed.data;
  const at = new Date().toISOString();
  const mine = async (id: string) => {
    const doc = await repo.translations.getById(id);
    return doc && isLaunchCopyTranslation(doc) && doc.campaignId === campaignId ? doc : null;
  };

  if (a.action === "approve" || a.action === "approve_all") {
    const revs = a.action === "approve" ? { [a.id]: a.rev } : a.revs;
    let approved = 0;
    let outOfDate = false;
    for (const [id, rev] of Object.entries(revs)) {
      if (!(await mine(id))) continue;
      await repo.translations.claim(id, (cur) => {
        if (!isLaunchCopyTranslation(cur) || cur.rev !== rev || cur.state !== "to_check" || !cur.draft) return null;
        if (cur.draft.sourceHash !== hash) {
          outOfDate = true;
          return null;
        }
        approved += 1;
        return { state: "approved", approved: { ...cur.draft, from: cur.from, approvedBy: ctx.userId ?? ctx.email ?? "admin", approvedAt: at }, draft: null, rev: cur.rev + 1, updatedAt: at };
      });
    }
    if (a.action === "approve") return approved ? ok({ approved }) : fail(409, outOfDate ? "out_of_date" : "changed");
    return ok({ approved, skipped: Object.keys(revs).length - approved });
  }

  if (a.action === "save") {
    const doc = await mine(a.id);
    if (!doc) return fail(404, "not_found");
    // A person's own words keep the page's shape: the same questions and answers, every token.
    const src = doc.source;
    const shapeKept =
      a.fields.questions.length === src.questions.length &&
      a.fields.questions.every((q, i) => (q.answers?.length ?? -1) === (src.questions[i]!.answers?.length ?? -1)) &&
      tokensOf(JSON.stringify(src)).join() === tokensOf(JSON.stringify(a.fields)).join();
    if (!shapeKept) return fail(400, "shape_changed");
    if (!a.fields.waitlistName.trim()) return fail(400, "empty");
    let moved = false;
    await repo.translations.claim(a.id, (cur) => {
      if (!isLaunchCopyTranslation(cur) || cur.rev !== a.rev || cur.state === "queued") {
        moved = true;
        return null;
      }
      return { state: "to_check", draft: { fields: a.fields, sourceHash: cur.sourceHash, by: "person", at }, failReason: null, rev: cur.rev + 1, updatedAt: at };
    });
    return moved ? fail(409, "changed") : ok({ saved: true });
  }

  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  if (!tenantMayUse(tenant, "translations")) return fail(403, "not_included");
  if (!launchLanguages(campaign, tenant).includes(a.lang)) return fail(400, "not_in_your_languages");
  if (await isRateLimited(`${ctx.tenantId}:${ctx.userId ?? "admin"}`, RATE, { db })) return fail(429, "rate_limited");
  return ok({ queued: await queueLaunchTranslations(ctx, { campaign, tenant, extra: [a.lang] }, db) });
}
