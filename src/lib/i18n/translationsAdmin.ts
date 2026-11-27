import { z } from "zod";
import { forTenant, getTenantById } from "@/lib/tenant";
import { markTranslationsQueued } from "@/lib/tenant/translations";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import type { PoolItem } from "@/lib/types/lifecycle";
import type { Tenant } from "@/lib/types/tenant";
import { EmailWordsSchema, translationIdOf, type Translation } from "@/lib/types/translation";
import { languagesFor } from "./assetLanguages";
import { isTranslatable, wordsHash, wordsOf } from "./emailWords";
import { isAssetTranslationsEnabled } from "./flags";
import { brandLanguages, languageReaders, minReadersOf } from "./languageReaders";
import { languageName, localeInfo } from "./locale";
import { tokensOf } from "./translate";
import { emailsOf, journeySource, planJourney } from "./translationsTick";
import { emailLanguageFor } from "./emailVersion";

/**
 * The journey editor's language tabs and the Review row (ASSET_TRANSLATIONS_ENABLED): what each
 * email has in each language, and the four things a person does with it. Reads are open to members;
 * the actions are admin only (the route's gate). Making translations needs the brand's
 * `translations` feature; approving what was made does not.
 */

type Result = { status: number; body: unknown };
const ok = (body: unknown): Result => ({ status: 200, body });
const fail = (status: number, error: string, detail?: unknown): Result => ({ status, body: detail === undefined ? { error } : { error, detail } });

/** What a tab shows, worked out on the server, where the words are hashed. */
export type TabState =
  | "not_made" // no translation, and the language is under the threshold: Make anyway
  | "waiting" // the language is ready and the journey is published: the next run makes it
  | "translating"
  | "to_check"
  | "approved"
  | "changed" // the draft's words changed since the approved translation: it updates when published
  | "out_of_date" // the published words changed: an update is on its way
  | "failed"
  | "not_translatable"; // a block layout: stays in the default language

/** What GET answers: the journey's languages and each email's tabs. */
export interface TranslationsViewBody {
  allowed: boolean;
  base: { code: string; name: string; nativeName: string };
  minReaders: number;
  languages: Array<{ code: string; name: string; nativeName: string; readers: number; ready: boolean; more: number }>;
  baseReaders: number | null;
  published: boolean;
  emails: Array<{ poolId: string; itemId: string; label: string; tabs: TabView[] }>;
  emailLanguages: Record<string, import("@/lib/email/emailRender").EmailLanguage>;
}

export interface TabView {
  lang: string;
  state: TabState;
  id: string;
  rev: number | null;
  draft: Translation["draft"];
  approved: Translation["approved"];
  failReason: string | null;
}

/** Whether a brand sees the language tabs: the switch, two languages or more, and the feature. */
export function translationsFeature(tenant: Tenant | null): boolean {
  return isAssetTranslationsEnabled() && brandLanguages(tenant).length > 1 && tenantMayUse(tenant, "translations");
}

function stateOf(t: Translation | undefined, words: { published: string | null; draft: string }, ready: boolean, published: boolean): TabState {
  if (!t) return ready && published ? "waiting" : "not_made";
  if (t.state === "queued") return "translating";
  if (t.state === "failed") return "failed";
  if (t.state === "to_check") return "to_check";
  if (words.published && t.approved && t.approved.sourceHash !== words.published) return "out_of_date";
  if (t.approved && t.approved.sourceHash !== words.draft) return "changed";
  return "approved";
}

/** The journey's emails, each with a tab per language, and its languages with their readers. */
export async function translationsView(ctx: TenantContext, journeyId: string, db?: FirestoreLike): Promise<Result> {
  if (!isAssetTranslationsEnabled()) return fail(503, "translations_disabled");
  const repo = forTenant(ctx, db);
  const [tenant, journey] = await Promise.all([getTenantById(ctx.tenantId, db).catch(() => null), repo.lifecycleJourneys.getById(journeyId)]);
  if (!journey) return fail(404, "not_found");
  if (!tenant) return fail(404, "not_found");
  const source = await journeySource(ctx, tenant, journeyId, db);
  const base = source?.base ?? brandLanguages(tenant)[0]!;
  const counted = await languageReaders(ctx, tenant, { db });
  const plan = languagesFor({ kind: "journey_email", base, list: brandLanguages(tenant), minReaders: minReadersOf(tenant), readers: counted?.readers ?? null });
  const ready = new Set(plan.extras.map((e) => e.code));
  const others = [...plan.extras, ...plan.skipped].map((l) => l.code);
  const docs = new Map((await repo.translations.find({ where: [["journeyId", "==", journeyId]] })).map((t) => [t.id, t]));
  const publishedHash = (poolId: string, itemId: string) => {
    const item = source?.version.pools.find((p) => p.id === poolId)?.items.find((i) => i.id === itemId);
    return item ? wordsHash(wordsOf(item)) : null;
  };
  const emails = journey.draft.pools.flatMap((pool) =>
    pool.items.map((item: PoolItem) => ({
      poolId: pool.id,
      itemId: item.id,
      label: item.label,
      tabs: others.map((lang): TabView => {
        const id = translationIdOf(journeyId, pool.id, item.id, lang);
        const t = docs.get(id);
        const state: TabState = isTranslatable(item)
          ? stateOf(t, { published: publishedHash(pool.id, item.id), draft: wordsHash(wordsOf(item)) }, ready.has(lang), Boolean(source))
          : "not_translatable";
        return { lang, state, id, rev: t?.rev ?? null, draft: t?.draft ?? null, approved: t?.approved ?? null, failReason: t?.failReason ?? null };
      }),
    })),
  );
  const readers = counted?.readers ?? {};
  return ok({
    allowed: tenantMayUse(tenant, "translations"),
    base: { code: base, name: languageName(base), nativeName: localeInfo(base).nativeName },
    minReaders: minReadersOf(tenant),
    languages: [
      ...plan.extras.map((l) => ({ code: l.code, name: languageName(l.code), nativeName: localeInfo(l.code).nativeName, readers: l.readers, ready: true, more: 0 })),
      ...plan.skipped.map((l) => ({ code: l.code, name: languageName(l.code), nativeName: localeInfo(l.code).nativeName, readers: l.readers, ready: false, more: l.more })),
    ],
    baseReaders: readers[base] ?? null,
    published: Boolean(source),
    emails,
    // Each language's footer and progress words, so a preview shows the email as it is sent.
    emailLanguages: Object.fromEntries(others.map((code) => [code, emailLanguageFor(code)])),
  });
}

const Rev = z.number().int().nonnegative();
const ActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), id: z.string().min(1).max(300), rev: Rev }),
  z.object({ action: z.literal("approve_all"), revs: z.record(z.string().max(300), Rev).refine((r) => Object.keys(r).length <= 200) }),
  z.object({ action: z.literal("save"), id: z.string().min(1).max(300), rev: Rev, fields: EmailWordsSchema }),
  z.object({ action: z.literal("make"), lang: z.string().min(2).max(10).optional() }),
]);

const RATE = { prefix: "translations_make", burstLimit: 10, hourlyLimit: 60 };

/** Approve one translation the person saw at `rev`, made from the words now published. */
async function approveOne(ctx: TenantContext, id: string, rev: number, published: Map<string, string>, db?: FirestoreLike): Promise<"approved" | "moved" | "out_of_date" | "missing"> {
  const repo = forTenant(ctx, db);
  let outcome: "approved" | "moved" | "out_of_date" | "missing" = "missing";
  const at = new Date().toISOString();
  await repo.translations.claim(id, (cur) => {
    if (cur.rev !== rev || cur.state !== "to_check" || !cur.draft) {
      outcome = "moved";
      return null;
    }
    if (published.get(`${cur.poolId}/${cur.itemId}`) !== cur.draft.sourceHash) {
      outcome = "out_of_date";
      return null;
    }
    outcome = "approved";
    const approvedBy = ctx.userId ?? ctx.email ?? "admin";
    return { state: "approved", approved: { ...cur.draft, from: cur.from, approvedBy, approvedAt: at }, draft: null, rev: cur.rev + 1, updatedAt: at };
  });
  return outcome;
}

export async function translationsAction(ctx: TenantContext, journeyId: string, input: unknown, db?: FirestoreLike): Promise<Result> {
  if (!isAssetTranslationsEnabled()) return fail(503, "translations_disabled");
  const parsed = ActionInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input");
  const tenant = await getTenantById(ctx.tenantId, db).catch(() => null);
  if (!tenant) return fail(404, "not_found");
  const source = await journeySource(ctx, tenant, journeyId, db);
  if (!source) return fail(409, "not_published");
  const published = new Map(emailsOf(source.version).map((e) => [`${e.poolId}/${e.item.id}`, wordsHash(wordsOf(e.item))]));
  const repo = forTenant(ctx, db);
  const a = parsed.data;

  if (a.action === "approve") {
    const doc = await repo.translations.getById(a.id);
    if (!doc || doc.journeyId !== journeyId) return fail(404, "not_found");
    const r = await approveOne(ctx, a.id, a.rev, published, db);
    if (r === "approved") return ok({ approved: 1 });
    return fail(409, r === "out_of_date" ? "out_of_date" : "changed");
  }

  if (a.action === "approve_all") {
    let approved = 0;
    let skipped = 0;
    for (const [id, rev] of Object.entries(a.revs)) {
      const doc = await repo.translations.getById(id);
      if (!doc || doc.journeyId !== journeyId) {
        skipped += 1;
        continue;
      }
      if ((await approveOne(ctx, id, rev, published, db)) === "approved") approved += 1;
      else skipped += 1;
    }
    return ok({ approved, skipped });
  }

  if (a.action === "save") {
    const doc = await repo.translations.getById(a.id);
    if (!doc || doc.journeyId !== journeyId) return fail(404, "not_found");
    const hash = published.get(`${doc.poolId}/${doc.itemId}`);
    if (!hash) return fail(409, "out_of_date");
    // A person's own words may change a link, but never a merge token: a lost one would empty it.
    const item = source.version.pools.find((p) => p.id === doc.poolId)?.items.find((i) => i.id === doc.itemId);
    const base = item ? wordsOf(item) : null;
    const tokensKept = base && (["subject", "previewText", "body"] as const).every((k) => tokensOf(base[k] ?? "").join() === tokensOf(a.fields[k] ?? "").join());
    if (!tokensKept) return fail(400, "tokens_changed");
    if (!a.fields.subject.trim() || !a.fields.body.trim()) return fail(400, "empty");
    const at = new Date().toISOString();
    let moved = false;
    await repo.translations.claim(a.id, (cur) => {
      if (cur.rev !== a.rev || cur.state === "queued") {
        moved = true;
        return null;
      }
      return { state: "to_check", draft: { fields: a.fields, sourceHash: hash, by: "person", at }, failReason: null, rev: cur.rev + 1, updatedAt: at };
    });
    return moved ? fail(409, "changed") : ok({ saved: true });
  }

  // make: Make versions (no language), or Make anyway, Update now or Try again for one language.
  if (!tenantMayUse(tenant, "translations")) return fail(403, "not_included");
  if (a.lang && (a.lang === source.base || !brandLanguages(tenant).includes(a.lang))) return fail(400, "not_in_your_languages");
  if (await isRateLimited(`${ctx.tenantId}:${ctx.userId ?? "admin"}`, RATE, { db })) return fail(429, "rate_limited");
  const nowMs = Date.now();
  const r = await planJourney(ctx, tenant, source, { db, nowMs, extra: a.lang ? [a.lang] : [] });
  if (r.queued > 0) await markTranslationsQueued(ctx.tenantId, new Date(nowMs).toISOString(), db);
  return ok({ queued: r.queued });
}

/** For Review: each journey with translations to check, and the revs its Approve all names. */
export async function translationsToCheck(ctx: TenantContext, db?: FirestoreLike): Promise<Array<{ journeyId: string; langs: string[]; revs: Record<string, number> }>> {
  if (!isAssetTranslationsEnabled()) return [];
  const rows = await forTenant(ctx, db).translations.find({ where: [["state", "==", "to_check"]], limit: 200 });
  const byJourney = new Map<string, { langs: Set<string>; revs: Record<string, number> }>();
  for (const t of rows) {
    const j = byJourney.get(t.journeyId) ?? { langs: new Set<string>(), revs: {} };
    j.langs.add(t.lang);
    j.revs[t.id] = t.rev;
    byJourney.set(t.journeyId, j);
  }
  return [...byJourney].map(([journeyId, j]) => ({ journeyId, langs: [...j.langs].sort(), revs: j.revs }));
}
