import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { listSituations } from "@/lib/brandMap/situations";
import { decidedBrandMap } from "@/lib/brandMap/store";
import { readBrandStrategy, type Strategy } from "@/lib/brandStrategy/store";
import { isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors } from "@/lib/competitors/store";
import { listRepoAnalyses, readMap } from "@/lib/connect/repoAnalysis";
import { proves, type ProductMap } from "@/lib/connect/productMapSchema";
import { resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { listBusinessFacts } from "@/lib/onboarding/store";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isSearchEnabled } from "@/lib/search/flags";
import { searchBrand } from "@/lib/search/query";
import type { BrandAuthor } from "@/lib/types/brandAuthor";
import type { BrandMap } from "@/lib/types/brandMap";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import { COMPETITOR_GROUP_LABEL } from "@/lib/types/brandStrategy";
import type { BusinessFact } from "@/lib/types/onboarding";
import type { Tenant } from "@/lib/types/tenant";
import { metricReader, numberOptions, type MetricDeps, type MetricReader, type NumberOptions } from "./metrics";
import { RAISE_DOC_LIMITS as L, type DeckAudience, type DeckStage, type PackLine, type SourceLabel } from "./types";
import type { MissingKey } from "./words";

/**
 * The deck context pack: what YouGrow knows about the business, gathered once for a draft or a
 * revise and never stored apart from the draft's `sources`. The shape of the brand context pack
 * (src/lib/brandContext/pack.ts): parts of short lines, each with where it came from, a link and a
 * date, at most 5 a part and 220 characters a line, plus what couldn't be seen (`missing`), which
 * becomes a Needs on its slide. Every read fails soft and respects its own switch.
 *
 * Text in the pack comes from the brand's site, repo and records: data for the model, never
 * instructions (the prompt fences it as untrusted).
 */

export const PACK_PARTS = ["identity", "customers", "problem", "site", "product", "edge", "competition", "team", "goal"] as const;
export type PackPart = (typeof PACK_PARTS)[number];

/** Lines per part, at most. */
export const PART_MAX = 5;

interface Line {
  text: string;
  label: SourceLabel;
  url?: string;
  at?: string;
}

export interface PackAuthor {
  /** "A1" to "A4", as the prompt names them. */
  ref: string;
  id: string;
  name: string;
  role: string;
  bio: string;
}

export interface RaisePack {
  /** The brand map's name, else the brand's; "" when neither is known. */
  brandName: string;
  parts: Record<PackPart, PackLine[]>;
  /** Every line, with ids P1 to P30, in part order. */
  lines: PackLine[];
  /** The brand voice, for tone only. */
  voice: string | null;
  /** Which numbers have data: never their values. */
  numbers: NumberOptions;
  /** The team slide's people come only from these. */
  authors: PackAuthor[];
  missing: MissingKey[];
}

export interface SiteHit {
  text: string;
  url?: string;
}

export interface RepoMap {
  name: string;
  connectionId: string;
  map: ProductMap;
  at?: string;
}

export interface RaisePackDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  brandMap?: (ctx: TenantContext) => Promise<BrandMap | null>;
  situations?: (ctx: TenantContext) => Promise<BrandMapSituation[]>;
  strategy?: (ctx: TenantContext) => Promise<Strategy | null>;
  competitors?: (ctx: TenantContext) => Promise<Array<{ name: string; url?: string }>>;
  /** What the brand's own site says, for one question. */
  site?: (ctx: TenantContext, question: string) => Promise<SiteHit[]>;
  repo?: (ctx: TenantContext) => Promise<RepoMap[]>;
  authors?: (ctx: TenantContext) => Promise<BrandAuthor[]>;
  facts?: (ctx: TenantContext) => Promise<BusinessFact[]>;
  /** Shared with the draft, so the sign-ups are read once. */
  reader?: MetricReader;
  metrics?: MetricDeps;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cut = (s: string, n = L.sourceText) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : undefined);

async function soft<T>(label: string, p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p();
  } catch (err) {
    console.warn(`[raise] ${label} unavailable:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return fallback;
  }
}

/** What the brand's site says: brand search where it is on and granted, else the newest programme's knowledge. */
async function siteDefault(ctx: TenantContext, question: string, db?: FirestoreLike): Promise<SiteHit[]> {
  if (isSearchEnabled() && (await brandCanUse(ctx, "brand_search"))) {
    const out = await searchBrand(ctx, question, { kinds: ["knowledge"], limit: 6 });
    if (out.ok) return out.result.hits.map((h) => ({ text: h.snippet || h.title, url: h.url || undefined }));
  }
  const [newest] = (await forTenant(ctx, db).workspaces.find({ limit: 50 })).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  if (!newest) return [];
  const rag = await retrieveSemanticKnowledgeContext({ ctx, ownerKind: "workspace", ownerId: newest.id, queryText: question, limit: 3 }, { db });
  return (rag?.chunks ?? []).map((c) => ({ text: c.content, url: c.sourceUri || undefined }));
}

async function repoDefault(ctx: TenantContext, db?: FirestoreLike): Promise<RepoMap[]> {
  const out: RepoMap[] = [];
  for (const conn of await forTenant(ctx, db).productConnections.find({ limit: 20 })) {
    const latest = (await listRepoAnalyses(ctx, conn.id, db)).find((a) => a.status === "done" || a.status === "incomplete");
    const map = latest ? readMap(latest) : null;
    if (latest && map) out.push({ name: latest.productName || "your product", connectionId: conn.id, map, at: latest.finishedAt ?? latest.createdAt });
  }
  return out;
}

/** The product's map, never its code: the summary, first steps and facts, those backed by code first. */
function productLines(repos: RepoMap[]): Line[] {
  const out: Line[] = [];
  for (const r of repos) {
    const url = `/admin/products/${r.connectionId}`;
    const at = day(r.at);
    if (clean(r.map.summary)) out.push({ text: clean(r.map.summary), label: "repo", url, at });
    const steps = [...r.map.onboardingSteps].sort((a, b) => Number(b.evidence.some((e) => proves(e, "onboardingSteps"))) - Number(a.evidence.some((e) => proves(e, "onboardingSteps"))));
    if (steps.length) out.push({ text: `First steps in ${r.name}: ${steps.slice(0, 5).map((s) => clean(s.label)).join(", ")}.`, label: "repo", url, at });
    const facts = [...r.map.facts].sort((a, b) => Number(b.evidence.some((e) => proves(e, "facts"))) - Number(a.evidence.some((e) => proves(e, "facts"))));
    if (facts.length) out.push({ text: `What ${r.name} keeps track of: ${facts.slice(0, 6).map((f) => clean(f.label)).join(", ")}.`, label: "repo", url, at });
  }
  return out;
}

const siteQuestions = (brand: string) => (brand ? [`What ${brand} does and who it is for`, `${brand} prices`] : ["What the business does and who it is for", "Prices"]);

/** The pack for a deck of this kind. */
export async function raiseContext(ctx: TenantContext, ask: { audience: DeckAudience; stage: DeckStage }, deps: RaisePackDeps = {}): Promise<RaisePack> {
  const db = deps.db;
  const tenant = await soft("tenant", () => (deps.loadTenant ?? getTenantById)(ctx.tenantId), null);
  const map = await soft("brand map", () => (deps.brandMap ?? ((c) => decidedBrandMap(c, db)))(ctx), null);
  const brandName = clean(map?.identity.name) || clean(tenant?.tenantName);
  const reader = deps.reader ?? metricReader(ctx, deps.metrics ?? { db });

  const [situations, strategy, watched, sites, repos, authors, facts, numbers] = await Promise.all([
    soft("situations", () => (deps.situations ?? ((c) => (isBrandMapSituationsEnabled() ? listSituations(c, { db }) : Promise.resolve([]))))(ctx), [] as BrandMapSituation[]),
    soft("brand strategy", () => (deps.strategy ?? ((c) => readBrandStrategy(c, { db })))(ctx), null),
    soft("competitors", () => (deps.competitors ?? (async (c) => (isCompetitorsEnabled() ? (await listCompetitors(c, { db })).map((x) => ({ name: x.name, url: x.website })) : [])))(ctx), [] as Array<{ name: string; url?: string }>),
    Promise.all(siteQuestions(brandName).map((q) => soft("site", () => (deps.site ?? ((c, question) => siteDefault(c, question, db)))(ctx, q), [] as SiteHit[]))),
    soft("repo", () => (deps.repo ?? ((c) => repoDefault(c, db)))(ctx), [] as RepoMap[]),
    soft("team list", () => (deps.authors ?? ((c) => forTenant(c, db).brandAuthors.find({ limit: 20 })))(ctx), [] as BrandAuthor[]),
    soft("about your business", () => (deps.facts ?? ((c) => listBusinessFacts(c, { db })))(ctx), [] as BusinessFact[]),
    soft("numbers", () => numberOptions(reader), { waitlist: { weeks: 12, hasData: false }, growth: { hasData: false }, launches: null } as NumberOptions),
  ]);

  const raw: Record<PackPart, Line[]> = {
    identity: [],
    customers: [],
    problem: [],
    site: [],
    product: productLines(repos),
    edge: [],
    competition: [],
    team: [],
    goal: [],
  };

  if (map) {
    const id = map.identity;
    if (clean(id.statement)) raw.identity.push({ text: clean(id.statement), label: "brand_map", url: id.site || undefined });
    if (clean(id.category)) raw.identity.push({ text: `${brandName} is in the category ${clean(id.category)}.`, label: "brand_map" });
    if (id.isNot.length) raw.identity.push({ text: `What ${brandName} is not: ${id.isNot.map(clean).join("; ")}.`, label: "brand_map" });
    const audiences = map.names.filter((n) => n.kind === "audience").map((n) => clean(n.name));
    if (audiences.length) raw.customers.push({ text: `Who buys: ${audiences.join(", ")}.`, label: "brand_map" });
  }
  for (const a of strategy?.audiences ?? []) raw.customers.push({ text: clean(a), label: "brand_strategy" });
  for (const s of situations) {
    const tail = [clean(s.want) && `wanting ${clean(s.want)}`, clean(s.feel) && `feeling ${clean(s.feel)}`].filter(Boolean).join(", ");
    raw.problem.push({ text: `"${clean(s.text)}"${tail ? `, ${tail}` : ""}${clean(s.who) ? ` (${clean(s.who)})` : ""}`, label: "brand_map" });
  }

  const seen = new Set<string>();
  for (const hit of sites.flat()) {
    const t = clean(hit.text);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    raw.site.push({ text: t, label: "website", url: hit.url });
  }

  if (strategy) {
    for (const c of strategy.claims) if (c.side === "you" && c.proof) raw.edge.push({ text: clean(c.text), label: "brand_strategy", url: c.proof.url });
    if (strategy.goal) raw.edge.push({ text: `This quarter's goal: ${clean(strategy.goal.text)}${clean(strategy.goal.measure) ? `, measured by ${clean(strategy.goal.measure)}` : ""}.`, label: "brand_strategy" });
    for (const g of strategy.competitorGroups) {
      if (g.competitors.length) raw.competition.push({ text: `${COMPETITOR_GROUP_LABEL[g.kind]}: ${g.competitors.map((c) => clean(c.name)).join(", ")}.`, label: "brand_strategy" });
    }
  }
  if (!raw.competition.length && watched.length) {
    raw.competition.push({ text: `Competitors you watch: ${watched.map((w) => clean(w.name)).join(", ")}.`, label: "competitors" });
  }

  const team = authors.filter((a) => clean(a.name)).slice(0, 4);
  for (const a of team) raw.team.push({ text: [clean(a.name), clean(a.role)].filter(Boolean).join(", ") + (clean(a.bio) ? `: ${clean(a.bio)}` : ""), label: "team", url: a.url || undefined });
  for (const f of facts) if (f.kind === "goal" || f.kind === "timeline" || f.kind === "constraint") raw.goal.push({ text: clean(f.text), label: "about", at: day(f.heardAt) });

  // Ids in part order, at most 5 a part and 30 in all.
  const parts = Object.fromEntries(PACK_PARTS.map((p) => [p, [] as PackLine[]])) as Record<PackPart, PackLine[]>;
  const lines: PackLine[] = [];
  for (const p of PACK_PARTS) {
    for (const l of raw[p].filter((x) => x.text).slice(0, PART_MAX)) {
      if (lines.length >= L.sources) break;
      const line: PackLine = { id: `P${lines.length + 1}`, text: cut(l.text), label: l.label, ...(l.url ? { url: l.url.slice(0, 600) } : {}), ...(l.at ? { at: l.at } : {}) };
      parts[p].push(line);
      lines.push(line);
    }
  }

  const missing: MissingKey[] = [];
  if (!team.length) missing.push("team");
  if (ask.audience === "investor") {
    if (!parts.competition.length) missing.push("competition");
    if (!parts.site.length && !parts.identity.length) missing.push("site");
    if (!numbers.waitlist.hasData) missing.push("demand");
    missing.push("market", "raise");
  } else {
    missing.push("sales", "borrow", "repayment");
  }

  return {
    brandName,
    parts,
    lines,
    voice: resolveBrandVoiceText({ tenantBrandVoice: tenant?.brandVoice }),
    numbers,
    authors: team.map((a, i) => ({ ref: `A${i + 1}`, id: a.id, name: clean(a.name).slice(0, L.personName), role: clean(a.role).slice(0, L.personRole), bio: clean(a.bio) })),
    missing,
  };
}
