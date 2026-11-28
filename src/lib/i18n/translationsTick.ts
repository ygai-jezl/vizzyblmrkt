import { forTenant } from "@/lib/tenant";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import { listAllTenants } from "@/lib/tenant/registry";
import { clearTranslationsQueued, takeTranslationCall } from "@/lib/tenant/translations";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { versionDocId } from "@/lib/lifecycle/enrol";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import type { LifecycleJourney, LifecycleVersion, PoolItem } from "@/lib/types/lifecycle";
import type { Tenant } from "@/lib/types/tenant";
import { translationIdOf, type Translation } from "@/lib/types/translation";
import { languagesFor } from "./assetLanguages";
import { isTranslatable, wordsHash, wordsOf } from "./emailWords";
import { isAssetTranslationsEnabled } from "./flags";
import { brandLanguages, languageReaders, minReadersOf } from "./languageReaders";
import { DEFAULT_LOCALE, normalizeLocale, resolveCampaignLocale } from "./locale";
import { TRANSLATE_TIMEOUT_MS, translateEmail, translationUsage, type TranslateInput, type TranslateResult } from "./translate";

/**
 * The translations lane of the lifecycle tick (ASSET_TRANSLATIONS_ENABLED). It runs on every tick,
 * since people wait on "Translating", but reads only brands whose record carries the mark a publish
 * or Make versions left (`translationsQueuedAt`), and only brands that may use translations.
 *
 * For each marked brand:
 *   1. each journey marked due is planned: every email of its published version is hashed, and a
 *      translation is queued for each language with enough readers, and for each language that
 *      already has one, whose words changed. Translations of emails that are gone are removed.
 *   2. queued translations are made, a few a run, each under a lease and the brand's daily cap.
 *   3. with nothing left, the brand's mark is cleared, only if no publish moved it meanwhile.
 *
 * The same planning and the one-translation step serve the admin actions (Make anyway, Update now,
 * Try again, Make versions) in src/lib/i18n/translationsAdmin.ts.
 */

export const LANE = {
  /** The lane's share of the tick. */
  BUDGET_MS: 95_000,
  /** The most model calls one run makes, across brands. */
  CALLS_PER_RUN: 4,
  /** A call starts only with this much of the run left. */
  MIN_START_MS: TRANSLATE_TIMEOUT_MS + 5_000,
  /** No brand starts with less than this left. */
  MIN_BRAND_MS: 3_000,
  /** A translation a run holds is free again after this. */
  LEASE_MS: 2 * TRANSLATE_TIMEOUT_MS,
  /** Journeys one brand plans a run. */
  JOURNEYS_PER_RUN: 10,
  /** Translation calls one brand makes a day. */
  DAILY_CAP: 200,
} as const;

export interface TranslationsDeps {
  db?: FirestoreLike;
  now?: () => number;
  listTenants?: () => Promise<Tenant[]>;
  translate?: (input: TranslateInput) => Promise<TranslateResult>;
  log?: (line: string) => void;
}

export interface TranslationsResult {
  brands: number;
  planned: number;
  queued: number;
  made: number;
  failed: number;
  capped: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A published journey's emails and what a translation of them needs. */
export interface JourneySource {
  journey: LifecycleJourney;
  version: LifecycleVersion;
  /** The language its emails are written in: the launch's for a launch journey, else the brand's. */
  base: string;
  /** Names that must not change. */
  glossary: string[];
}

export async function journeySource(ctx: TenantContext, tenant: Tenant, journeyId: string, db?: FirestoreLike): Promise<JourneySource | null> {
  const repo = forTenant(ctx, db);
  const journey = await repo.lifecycleJourneys.getById(journeyId);
  if (!journey || journey.status === "archived" || !journey.publishedVersion) return null;
  const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
  if (!version) return null;
  let base = normalizeLocale(tenant.defaultLocale) ?? DEFAULT_LOCALE;
  const names = [tenant.tenantName];
  if (journey.audience?.kind === "waitlist") {
    const campaign = await repo.campaigns.getById(journey.audience.campaignId);
    if (campaign) {
      base = normalizeLocale(resolveCampaignLocale(campaign, tenant)) ?? base;
      names.push(campaign.productName ?? "", campaign.waitlistName ?? "");
    }
  } else if (journey.connectionId) {
    const connection = await repo.productConnections.getById(journey.connectionId);
    if (connection) names.push(connection.name);
  }
  return { journey, version, base, glossary: [...new Set(names.map((n) => n.trim()).filter(Boolean))] };
}

/** The emails of a published version that can be translated, with their pool. */
export function emailsOf(version: Pick<LifecycleVersion, "pools">): Array<{ poolId: string; item: PoolItem }> {
  return version.pools.flatMap((pool) => pool.items.filter(isTranslatable).map((item) => ({ poolId: pool.id, item })));
}

/** A new translation record, queued. */
function queuedRecord(source: JourneySource, poolId: string, item: PoolItem, lang: string, nowMs: number, anyway: boolean) {
  return {
    kind: "journey_email" as const,
    journeyId: source.journey.id,
    poolId,
    itemId: item.id,
    lang,
    from: source.base,
    state: "queued" as const,
    rev: 0,
    sourceHash: wordsHash(wordsOf(item)),
    draft: null,
    approved: null,
    failReason: null,
    leaseUntil: null,
    ...(anyway ? { anyway: true } : {}),
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
  };
}

/**
 * Queue what a published journey needs: each email in each language with enough readers (and in
 * `extra`, the languages a person asked for with Make versions or Make anyway), plus each language
 * an email already has, whose words or base changed. Removes the translations of emails that are
 * gone. Returns how many it queued and removed.
 */
export async function planJourney(
  ctx: TenantContext,
  tenant: Tenant,
  source: JourneySource,
  opts: { db?: FirestoreLike; nowMs: number; extra?: readonly string[] },
): Promise<{ queued: number; removed: number }> {
  const repo = forTenant(ctx, opts.db);
  const counted = await languageReaders(ctx, tenant, { db: opts.db, now: () => opts.nowMs });
  const plan = languagesFor({
    kind: "journey_email",
    base: source.base,
    list: brandLanguages(tenant),
    minReaders: minReadersOf(tenant),
    readers: counted?.readers ?? null,
  });
  const ready = new Set(plan.extras.map((e) => e.code));
  const asked = new Set((opts.extra ?? []).filter((c) => c !== source.base));
  const existing = await repo.translations.find({ where: [["journeyId", "==", source.journey.id]] });
  const byId = new Map(existing.map((t) => [t.id, t]));
  const emails = emailsOf(source.version);
  const keep = new Set<string>();
  let queued = 0;
  for (const { poolId, item } of emails) {
    const hash = wordsHash(wordsOf(item));
    const has = existing.filter((t) => t.poolId === poolId && t.itemId === item.id).map((t) => t.lang);
    for (const lang of new Set([...ready, ...asked, ...has])) {
      const id = translationIdOf(source.journey.id, poolId, item.id, lang);
      keep.add(id);
      const doc = byId.get(id);
      if (doc && doc.sourceHash === hash && doc.from === source.base && doc.state !== "failed") continue;
      if (doc && doc.state === "failed" && doc.sourceHash === hash && !asked.has(lang)) continue;
      await repo.translations.upsert(
        id,
        () => queuedRecord(source, poolId, item, lang, opts.nowMs, asked.has(lang) && !ready.has(lang)),
        (cur) => ({ state: "queued", sourceHash: hash, from: source.base, failReason: null, leaseUntil: null, rev: cur.rev + 1, updatedAt: iso(opts.nowMs) }),
      );
      queued += 1;
    }
  }
  let removed = 0;
  for (const t of existing) {
    if (keep.has(t.id) || emails.some((e) => e.poolId === t.poolId && e.item.id === t.itemId)) continue;
    await repo.translations.delete(t.id).catch(() => {});
    removed += 1;
  }
  return { queued, removed };
}

export type TranslateOutcome = "made" | "failed" | "capped" | "busy" | "gone";

/**
 * Make one queued translation: hold it, take a call from the brand's day, translate the published
 * words, and keep the draft for a person to check (or the reason it failed). The published words
 * are read again here, so a translation never answers words that have since changed.
 */
export async function translateOne(
  ctx: TenantContext,
  tenant: Tenant,
  id: string,
  opts: { db?: FirestoreLike; nowMs: number; translate?: TranslationsDeps["translate"]; source?: JourneySource | null },
): Promise<TranslateOutcome> {
  const repo = forTenant(ctx, opts.db);
  const now = iso(opts.nowMs);
  const lease = iso(opts.nowMs + LANE.LEASE_MS);
  const held = await repo.translations.claim(id, (cur) =>
    cur.state === "queued" && !(cur.leaseUntil && cur.leaseUntil > now) ? { leaseUntil: lease } : null,
  );
  if (!held) return "busy";
  const release = (patch: Partial<Translation> = {}) =>
    repo.translations.claim(id, (cur) => (cur.leaseUntil === lease ? { leaseUntil: null, ...patch } : null)).catch(() => null);

  const source = opts.source ?? (await journeySource(ctx, tenant, held.journeyId, opts.db));
  if (!source) {
    // Archived or never published: kept, so a journey that comes back still has its translations.
    await release({ state: "failed", failReason: "The journey isn't published.", rev: held.rev + 1, updatedAt: now });
    return "failed";
  }
  const item = source.version.pools.find((p) => p.id === held.poolId)?.items.find((i) => i.id === held.itemId);
  if (!item || !isTranslatable(item)) {
    await repo.translations.delete(id).catch(() => {});
    return "gone";
  }
  if (!(await takeTranslationCall(ctx.tenantId, now.slice(0, 10), LANE.DAILY_CAP, opts.db))) {
    await release();
    return "capped";
  }
  const words = wordsOf(item);
  const hash = wordsHash(words);
  const res = await (opts.translate ?? translateEmail)({ words, from: source.base, to: held.lang, glossary: source.glossary, usage: translationUsage(ctx, tenant) });
  const at = iso(opts.nowMs);
  const written = await repo.translations.claim(id, (cur) => {
    if (cur.leaseUntil !== lease) return null;
    const common = { leaseUntil: null, sourceHash: hash, from: source.base, rev: cur.rev + 1, updatedAt: at };
    return res.ok
      ? { ...common, state: "to_check" as const, failReason: null, draft: { fields: res.fields, sourceHash: hash, by: "ai" as const, at } }
      : { ...common, state: "failed" as const, failReason: res.reason.slice(0, 300) };
  });
  if (!written) return "busy";
  // What made it (LOOPS_ENABLED, learning loops step 5): counted made once its draft is kept, with
  // no stamp on the record yet and no type, as a translation is part of its journey, not a new one.
  if (res.ok) await countMade(ctx, "translation", (await learnedFor(ctx, "translation", { promptId: "i18n.translate_email" })).stamp, { db: opts.db });
  return res.ok ? "made" : "failed";
}

/** The lane. */
export async function runTranslations(opts: { deadlineMs: number }, deps: TranslationsDeps = {}): Promise<TranslationsResult> {
  const result: TranslationsResult = { brands: 0, planned: 0, queued: 0, made: 0, failed: 0, capped: 0 };
  if (!isAssetTranslationsEnabled()) return result;
  const clock = deps.now ?? Date.now;
  const tenants = (await (deps.listTenants ?? (() => listAllTenants(deps.db)))())
    .filter((t) => t.translationsQueuedAt && t.status !== "suspended" && tenantMayUse(t, "translations"))
    .sort((a, b) => (a.translationsQueuedAt! < b.translationsQueuedAt! ? -1 : 1));
  let calls = 0;
  for (const t of tenants) {
    if (opts.deadlineMs - clock() < LANE.MIN_BRAND_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const repo = forTenant(ctx, deps.db);
    const seen = t.translationsQueuedAt!;
    try {
      result.brands += 1;
      const due = await repo.lifecycleJourneys.find({ where: [["translationsDue", "==", true]], limit: LANE.JOURNEYS_PER_RUN });
      for (const j of due) {
        const source = await journeySource(ctx, t, j.id, deps.db);
        if (source) {
          const r = await planJourney(ctx, t, source, { db: deps.db, nowMs: clock() });
          result.planned += 1;
          result.queued += r.queued;
        }
        await repo.lifecycleJourneys.claim(j.id, (cur) => (cur.translationsDueAt === j.translationsDueAt ? { translationsDue: false } : null));
      }
      let capped = false;
      const queued = await repo.translations.find({ where: [["state", "==", "queued"]], limit: LANE.CALLS_PER_RUN + 1 });
      for (const q of queued) {
        if (calls >= LANE.CALLS_PER_RUN || opts.deadlineMs - clock() < LANE.MIN_START_MS) break;
        const outcome = await translateOne(ctx, t, q.id, { db: deps.db, nowMs: clock(), translate: deps.translate });
        if (outcome === "made" || outcome === "failed") calls += 1;
        if (outcome === "made") result.made += 1;
        if (outcome === "failed") result.failed += 1;
        if (outcome === "capped") {
          capped = true;
          result.capped += 1;
          break;
        }
      }
      // Nothing left: clear the mark (unless a publish moved it). A capped brand keeps it for tomorrow.
      if (!capped && due.length < LANE.JOURNEYS_PER_RUN) {
        const left = await repo.translations.find({ where: [["state", "==", "queued"]], limit: 1 });
        if (left.length === 0) await clearTranslationsQueued(t.id, seen, deps.db);
      }
    } catch (err) {
      console.warn(`[translations] ${t.id}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  (deps.log ?? ((line: string) => console.info(line)))(
    `[translations] ${result.brands} brands, ${result.planned} journeys planned, ${result.queued} queued, ${result.made} made, ${result.failed} failed, ${result.capped} capped`,
  );
  return result;
}
