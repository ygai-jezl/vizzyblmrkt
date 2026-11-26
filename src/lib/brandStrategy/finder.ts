import { generateGroundedText, isGeminiConfigured, isSearchLimited, type AiUsage, type GroundedTextResult } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { fold } from "@/lib/brandMap/changes";
import { clean, fence, oneLine } from "@/lib/brandMap/lineChecks";
import { readBrandMap } from "@/lib/brandMap/store";
import { blogResearchThinkingBudget } from "@/lib/content/blog/flags";
import { siteOf, sitesOf, tenantDomains } from "@/lib/knowledge/site";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { brandMonthlyLimit } from "@/lib/plans/limits";
import { aiUsage } from "@/lib/plans/meter";
import { brandMarket, marketOf } from "@/lib/signals/markets";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { CompetitorGroupKind, BRAND_STRATEGY_LIMITS as L, type BrandStrategyDoc, type StrategyEvidence } from "@/lib/types/brandStrategy";
import type { ProfileRun } from "@/lib/types/businessProfile";
import type { Tenant } from "@/lib/types/tenant";
import { claimFinderRun, fullRunsInMonth, readBrandStrategyDoc, releaseFinderRun, saveFound, type FoundCompetitor } from "./store";

/**
 * The competitor finder (COMPETITOR_FINDER_ENABLED), on the Strategy tab. Its answers come from
 * Google: a name counts only when the search results back it (a result from its own site, or a
 * stretch of the answer that names it backed by a result). The model's memory is never evidence.
 *
 *  - Quick: ONE grounded question built from who the brand is: "Who would a buyer of <what it
 *    is> in <its market> consider instead?". A brand without the competitor_finder feature gets
 *    one quick answer (at setup); one with it may run quick as often as the rate limit allows.
 *  - Full (the competitor_finder feature, 4 a month by default): the same question three times,
 *    merged, each name ranked by how many answers named it, then a gap search that fits the
 *    business (from the profile's "What you run"): alternatives pages for an app, other shops for
 *    a shop, local rivals for a service.
 *
 * Every search is metered under competitor_find (web searches and model tokens). What it finds
 * goes into the strategy's draft for a person to tick; nothing is watched until they do.
 */

export const FIND_PROMPT = "brand.competitor_find";
export const FULL_ASKS = 3;
/** Names one answer may give. */
const MAX_PER_ANSWER = 12;
/** Names a run keeps, best first. */
const MAX_KEPT = 20;
const FIND_MS = 45_000;

export type FinderMode = "quick" | "full";

export interface FinderDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  grounded?: typeof generateGroundedText;
  modelReady?: () => boolean;
  usage?: AiUsage;
  /** Whether the brand may use the full finder (tests). */
  canUse?: (ctx: TenantContext) => Promise<boolean>;
  /** The brand's monthly cap of full runs (tests). */
  monthlyLimit?: (ctx: TenantContext) => Promise<number>;
}

export interface FoundLine {
  name: string;
  site: string | null;
  group: CompetitorGroupKind;
}

/** Read the finder's answer: one COMPETITOR line each. Unknown lines and groups are skipped. Pure. */
export function parseFound(text: string): FoundLine[] {
  const out: FoundLine[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**COMPETITOR\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const parts = (m[1] ?? "").split(/\s*\|\s*/).map(clean);
    const name = (parts[0] ?? "").slice(0, L.competitorName);
    const group = CompetitorGroupKind.safeParse((parts[2] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
    if (!name || !group.success) continue;
    const site = /^(none|n\/a|-)?$/i.test(parts[1] ?? "") ? null : siteOf(parts[1] ?? "") || null;
    out.push({ name, site, group: group.data });
    if (out.length >= MAX_PER_ANSWER) break;
  }
  return out;
}

/** Whole words of `name` in `text`, both folded. */
const names = (text: string, name: string) => {
  const n = fold(name);
  return Boolean(n) && ` ${fold(text)} `.includes(` ${n} `);
};

/**
 * What one grounded answer found that its search results back: a site is kept only when a result
 * came from it, and each name carries up to 3 results (title and domain) as evidence. The brand
 * itself is left out. Pure.
 */
export function groundedFinds(answer: GroundedTextResult, brand: { name: string; own: Set<string> }): FoundCompetitor[] {
  const sources = answer.sources.map((s) => ({ title: oneLine(s.title).slice(0, L.evidenceTitle), domain: siteOf(s.domain) || oneLine(s.domain).slice(0, 253) }));
  const out: FoundCompetitor[] = [];
  for (const line of parseFound(answer.text)) {
    if (fold(line.name) === fold(brand.name) || (line.site && brand.own.has(line.site))) continue;
    const fromSite = line.site ? sources.filter((s) => s.domain === line.site) : [];
    const backing = answer.supports
      .filter((s) => s.sourceIndexes.length && names(s.text, line.name))
      .flatMap((s) => s.sourceIndexes.map((i) => sources[i]!))
      .filter(Boolean);
    const evidence: StrategyEvidence[] = [];
    for (const e of [...fromSite, ...backing]) {
      if (e.domain && !evidence.some((x) => x.domain === e.domain && x.title === e.title)) evidence.push(e);
    }
    if (!evidence.length) continue;
    out.push({ name: line.name, site: fromSite.length ? line.site : null, foundTimes: 1, evidence: evidence.slice(0, L.evidence), ticked: false, from: "finder", group: line.group });
  }
  return out;
}

/**
 * Merge answers: one entry per name (or site), how many answers named it, the group most of them
 * gave, and their evidence. Most named first, then in the order first found. Pure.
 */
export function mergeAnswers(answers: FoundCompetitor[][]): FoundCompetitor[] {
  const merged: Array<FoundCompetitor & { groups: CompetitorGroupKind[]; first: number }> = [];
  let order = 0;
  for (const answer of answers) {
    const counted = new Set<number>();
    for (const f of answer) {
      const at = merged.findIndex((m) => fold(m.name) === fold(f.name) || (m.site && f.site && m.site === f.site));
      if (at < 0) {
        merged.push({ ...f, foundTimes: f.foundTimes, groups: [f.group], first: order++ });
        counted.add(merged.length - 1);
        continue;
      }
      const m = merged[at]!;
      if (!counted.has(at)) {
        m.foundTimes += f.foundTimes;
        counted.add(at);
      }
      m.groups.push(f.group);
      m.site ??= f.site;
      for (const e of f.evidence) if (m.evidence.length < L.evidence && !m.evidence.some((x) => x.domain === e.domain && x.title === e.title)) m.evidence.push(e);
    }
  }
  const mostOf = (groups: CompetitorGroupKind[]) => {
    const counts = new Map<CompetitorGroupKind, number>();
    for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  return merged
    .sort((a, b) => b.foundTimes - a.foundTimes || a.first - b.first)
    .slice(0, MAX_KEPT)
    .map(({ groups, first: _f, ...m }) => {
      void _f;
      return { ...m, group: mostOf(groups) };
    });
}

/** The quick question, as the plan words it. */
export function quickQuestion(statement: string, market: string): string {
  return `Who would a buyer of ${statement} in ${market} consider instead?`;
}

/** The gap search that fits the business: alternatives pages for an app, other shops for a shop, local rivals for a service. */
export function gapQuestion(run: ProfileRun | undefined, about: { brand: string; statement: string; category: string; market: string }): string {
  const what = about.category || about.statement;
  if (run === "shop") return `Which other shops, online and in ${about.market}, sell what ${about.brand} sells (${about.statement})? Look at gift guides, marketplaces and "shops like" lists.`;
  if (run === "service") return `Search for "${what} near me" in ${about.market}: which local businesses and services come up as rivals, and what do people use instead of hiring one?`;
  return `Search for "alternatives to" and "vs" comparison pages about ${what}: which products do those pages name, including open source ones and one-feature tools?`;
}

export type FinderOutcome =
  /** `gapSkipped`: a full run's search that fits the business couldn't run (the month's web searches ran out). */
  | { ok: true; doc: BrandStrategyDoc; mode: FinderMode; found: number; asks: number; gapSkipped?: boolean }
  | { ok: false; status: number; error: string; current?: BrandStrategyDoc | null };

/**
 * Whether the brand may run the finder now: full needs competitor_finder and runs left this month;
 * quick works once without it.
 */
export async function mayFind(
  ctx: TenantContext,
  mode: FinderMode,
  doc: BrandStrategyDoc | null,
  deps: FinderDeps = {},
): Promise<{ ok: true; granted: boolean; used: number; limit: number | null } | { ok: false; status: number; error: string }> {
  const granted = await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_finder", deps.loadTenant)))(ctx).catch(() => false);
  if (mode === "quick") {
    if (!granted && doc?.finder.quickAt) return { ok: false, status: 403, error: "finder_quick_used" };
    return { ok: true, granted, used: 0, limit: null };
  }
  if (!granted) return { ok: false, status: 403, error: "finder_not_included" };
  const used = fullRunsInMonth(doc, (deps.now ?? (() => new Date()))());
  const limit = await (deps.monthlyLimit ?? ((c) => brandMonthlyLimit(c, "competitor_finder", deps.loadTenant)))(ctx);
  if (used >= limit) return { ok: false, status: 429, error: "finder_monthly_limit" };
  return { ok: true, granted, used, limit };
}

/** Run the finder and put what it found in the strategy's draft. */
export async function findCompetitors(ctx: TenantContext, input: { mode: FinderMode }, deps: FinderDeps = {}): Promise<FinderOutcome> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return { ok: false, status: 409, error: "no_brand_map" };
  const id = read.map.identity;
  const statement = oneLine(id.statement || id.category);
  if (!statement) return { ok: false, status: 409, error: "nothing_to_find" };
  const doc = await readBrandStrategyDoc(ctx, { db: deps.db }).catch(() => null);
  const may = await mayFind(ctx, input.mode, doc, deps);
  if (!may.ok) return may;
  // The run takes its place before it spends anything, so a second run at the same moment is refused.
  const claimed = await claimFinderRun(ctx, { mode: input.mode, granted: may.granted, limit: may.limit }, { db: deps.db, now: deps.now });
  if (!claimed.ok) return claimed;
  const release = () => releaseFinderRun(ctx, { mode: input.mode, at: claimed.value.at }, { db: deps.db, now: deps.now });

  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const brandName = oneLine(id.name || tenant?.tenantName || "");
  const own = sitesOf([id.site, ...tenantDomains(tenant)]);
  const market = marketOf(brandMarket(tenant?.searchMarket).country)?.name ?? "the brand's market";
  const site = id.site || (tenant?.rootDomain ? `https://${tenant.rootDomain.replace(/^https?:\/\//i, "")}` : "");
  const identity = [id.category ? `Category: ${id.category}` : "", id.statement ? `What it is: ${id.statement}` : "", ...id.isNot.map((t) => `It is not: ${t}`)].filter(Boolean).join("\n");
  const usage = deps.usage ?? aiUsage(ctx, "competitor_find", { db: deps.db, tenant });
  const now = (deps.now ?? (() => new Date()))();
  const ask = (question: string) =>
    (deps.grounded ?? generateGroundedText)(
      renderPrompt(FIND_PROMPT, {
        brand_name: brandName.replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
        site: site || "(no website set)",
        today: now.toISOString().slice(0, 10),
        identity: fence("brand", identity),
        question: fence("question", question),
        max: MAX_PER_ANSWER,
      }),
      { timeoutMs: FIND_MS, thinkingBudget: blogResearchThinkingBudget(), usage },
    ).catch(() => null);

  const quick = quickQuestion(statement, market);
  const questions =
    input.mode === "quick"
      ? [quick]
      : [...Array.from({ length: FULL_ASKS }, () => quick), gapQuestion(tenant?.businessProfile?.answers.run, { brand: brandName || "the brand", statement, category: oneLine(id.category), market })];
  const answers = await Promise.all(questions.map(ask));
  const usable = (a: (typeof answers)[number]): a is GroundedTextResult => Boolean(a) && !isSearchLimited(a);
  // The main question's answers decide the run; the gap search (a full run's last) only adds names.
  const asked = input.mode === "full" ? answers.slice(0, FULL_ASKS) : answers;
  const gapAnswer = input.mode === "full" ? answers[FULL_ASKS] : undefined;
  if (!asked.some(usable)) {
    // Nothing came back to save: the run gives its place back.
    await release();
    return asked.some(isSearchLimited) ? { ok: false, status: 429, error: "search_limit" } : { ok: false, status: 502, error: "find_failed" };
  }
  const brand = { name: brandName, own };
  const main = mergeAnswers(asked.filter(usable).map((a) => groundedFinds(a, brand)));
  const gap = gapAnswer && usable(gapAnswer) ? groundedFinds(gapAnswer, brand).map((f) => ({ ...f, foundTimes: 0 })) : [];
  const found = mergeAnswers([main, gap]);
  // A quick run that found nothing backed by search is not counted, so the one free answer isn't spent on nothing.
  if (!found.length && input.mode === "quick") {
    await release();
    return { ok: false, status: 502, error: "nothing_found" };
  }
  const saved = await saveFound(ctx, { mode: input.mode, found, counted: true }, { db: deps.db, now: deps.now });
  if (!saved.ok) return saved;
  return {
    ok: true,
    doc: saved.value,
    mode: input.mode,
    found: found.length,
    asks: questions.length,
    ...(gapAnswer !== undefined && isSearchLimited(gapAnswer) ? { gapSkipped: true } : {}),
  };
}
