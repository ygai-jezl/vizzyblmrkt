import { generateTextWithDeadline, isGeminiConfigured, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { getPrompt, renderPrompt } from "@/lib/agents/prompts/registry";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { fold } from "@/lib/brandMap/changes";
import { clean, fence, hasAddress, oneLine } from "@/lib/brandMap/lineChecks";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { listSituations } from "@/lib/brandMap/situations";
import { readBrandMap } from "@/lib/brandMap/store";
import { competitorCoverage, type CoverageFlag, type CoverageView } from "@/lib/competitors/coverage";
import { listCompetitors } from "@/lib/competitors/store";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { siteOf, sitesOf, tenantDomains } from "@/lib/knowledge/site";
import { answeredLabels } from "@/lib/onboarding/choices";
import { listBusinessFacts } from "@/lib/onboarding/store";
import { aiUsage } from "@/lib/plans/meter";
import { searchBrand, type SearchOutcome } from "@/lib/search/query";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import type { BusinessFact } from "@/lib/types/onboarding";
import type { Tenant } from "@/lib/types/tenant";
import type { Competitor } from "@/lib/types/competitor";
import {
  BRAND_STRATEGY_LIMITS as L,
  competitorsOf,
  type IsNotProposal,
  type StrategyClaim,
  type StrategyGoal,
  type StrategyProof,
  type StrategySource,
} from "@/lib/types/brandStrategy";
import { measureKeyOf, newClaimId, readBrandStrategyDoc, saveProposal, type ProposedStrategy, type StrategyResult } from "./store";
import type { BrandStrategyDoc } from "@/lib/types/brandStrategy";

/**
 * Propose with Vizzy (BRAND_STRATEGY_ENABLED): ONE Gemini call drafts the strategy from what the
 * brand already has, numbered as evidence: who it is (identity), its decided buying situations
 * with their question and live article counts, the competitors it watches with what they write
 * about, the ones the finder found, its own site's pages, passages from its knowledge with their
 * pages (up to 8), what its product does (the product map, read from its code), and what its
 * people told YouGrow (the profile and goal facts).
 *
 * Code keeps the last word on what comes back:
 *  - a focus situation is one of the brand's decided ones (3 to 5, filled from the busiest ones
 *    when the model gives too few);
 *  - a claim's proof names evidence it was handed, or the claim is left out; a claim with no
 *    proof stays as a gap to close, never as fact; a product fact from the code needs a public
 *    page or doc that shows it, and the code itself is never quoted;
 *  - no dashes as punctuation, none of the AI tells, no web address in any line;
 *  - each "what you're not" line is at most 80 characters and new.
 * Nothing it proposes is used until a person approves the strategy.
 */

export const PROPOSE_PROMPT = "brand.strategy_propose";
const MAX_SITUATIONS = 40;
const MAX_PAGES = 30;
const MAX_KNOWLEDGE = 8;
const MAX_WORKSPACES = 3;
const MAX_PRODUCT_FACTS = 3;
const MAX_CLAIMS = 8;
const MAX_THEIRS = 2;
const MAX_IS_NOT = 3;
const PROPOSE_MS = 45_000;

/** One numbered piece of evidence the model may name as proof. */
export interface EvidenceItem {
  id: string;
  kind: "site" | "knowledge" | "product_map" | "competitor";
  text: string;
  /** A public page that shows it; null for the product map (read from code). */
  url: string | null;
  title: string;
  /** For a competitor: their name. */
  name?: string;
}

/** What the propose step reads, gathered before the call. */
export interface StrategyInput {
  brandName: string;
  identity: { name: string; category: string; statement: string; isNot: string[]; avoid: Array<{ term: string; useInstead: string }> };
  audiences: string[];
  situations: Array<Pick<BrandMapSituation, "id" | "text" | "who" | "counts">>;
  profile: string[];
  goals: string[];
  evidence: EvidenceItem[];
  /** Competitors the brand watches, to add to the draft. */
  watched: Array<{ name: string; site: string | null }>;
  sources: StrategySource[];
}

export interface ProposeDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  generate?: typeof generateTextWithDeadline;
  modelReady?: () => boolean;
  retrieve?: typeof retrieveSemanticKnowledgeContext;
  search?: (ctx: TenantContext, query: string, opts: { kinds: ["repo_map"]; limit: number }) => Promise<SearchOutcome>;
  coverage?: (ctx: TenantContext) => Promise<CoverageView | null>;
  facts?: (ctx: TenantContext) => Promise<BusinessFact[]>;
  workspaces?: (ctx: TenantContext) => Promise<Array<{ id: string; archivedAt?: string | null; updatedAt?: string }>>;
  usage?: AiUsage;
}

const FLAG_WORD: Record<CoverageFlag, string> = {
  open: "nobody writes on it lately",
  gap: "only competitors write on it lately",
  crowded: "competitors write on it twice as much as the brand",
  you_lead: "the brand writes on it as much or more",
  even: "they write on it a little more than the brand",
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const soft = <T>(work: Promise<T>, fallback: T): Promise<T> => work.catch(() => fallback);
const httpsOf = (site: string) => (site ? `https://${site.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")}` : "");

/** What each competitor writes about most, from the coverage view: "Audits (6 articles in 90 days, only competitors write on it lately)". */
export function competitorTopics(view: CoverageView | null, competitorId: string): string {
  if (!view) return "";
  return view.rows
    .filter((r) => (r.byCompetitor[competitorId] ?? 0) > 0)
    .sort((a, b) => (b.byCompetitor[competitorId] ?? 0) - (a.byCompetitor[competitorId] ?? 0))
    .slice(0, 2)
    .map((r) => `${oneLine(r.name)} (${r.byCompetitor[competitorId]} articles in ${view.days} days, ${FLAG_WORD[r.flag]})`)
    .join("; ");
}

/** Read everything the propose step weighs, each part within a few seconds or left out. */
export async function gatherStrategyInput(ctx: TenantContext, deps: ProposeDeps = {}): Promise<StrategyInput | null> {
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return null;
  const map = read.map;
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const id = map.identity;
  const own = sitesOf([id.site, ...tenantDomains(tenant)]);
  const brandName = oneLine(id.name || tenant?.tenantName || "");
  const statement = oneLine(id.statement || id.category || brandName);

  const listWorkspaces = deps.workspaces ?? ((c: TenantContext) => forTenant(c, deps.db).workspaces.find({ where: [], limit: 200 }));
  const [situations, pages, competitors, view, facts, workspaces, doc] = await Promise.all([
    soft(listSituations(ctx, { db: deps.db }), [] as BrandMapSituation[]),
    soft(listBrandMapPages(ctx, deps.db), [] as BrandMapPage[]),
    soft(listCompetitors(ctx, { db: deps.db }), [] as Competitor[]),
    soft((deps.coverage ?? ((c) => competitorCoverage(c, { db: deps.db })))(ctx), null),
    soft((deps.facts ?? ((c) => listBusinessFacts(c, { db: deps.db })))(ctx), [] as BusinessFact[]),
    soft(listWorkspaces(ctx), [] as Array<{ id: string; archivedAt?: string | null; updatedAt?: string }>),
    soft(readBrandStrategyDoc(ctx, { db: deps.db }), null as BrandStrategyDoc | null),
  ]);
  const retrieve = deps.retrieve ?? retrieveSemanticKnowledgeContext;
  const live = workspaces
    .filter((w) => !w.archivedAt)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_WORKSPACES);
  const [knowledge, product] = await Promise.all([
    statement
      ? Promise.all(live.map((w) => soft(retrieve({ ctx, ownerKind: "workspace", ownerId: w.id, queryText: statement, limit: MAX_KNOWLEDGE, bypassEnabledFlag: true }), null)))
      : Promise.resolve([]),
    statement ? soft((deps.search ?? ((c, q, o) => searchBrand(c, q, o)))(ctx, statement, { kinds: ["repo_map"], limit: MAX_PRODUCT_FACTS }), null) : Promise.resolve(null),
  ]);

  const evidence: EvidenceItem[] = [];
  const urls = new Set<string>();
  let p = 0;
  for (const row of pages) {
    if (p >= MAX_PAGES) break;
    if (row.kind !== "site" || !row.url || !/^https:\/\//i.test(row.url) || urls.has(row.url) || !own.has(siteOf(row.url))) continue;
    urls.add(row.url);
    p += 1;
    evidence.push({ id: `P${p}`, kind: "site", text: oneLine(row.title || new URL(row.url).pathname), url: row.url, title: oneLine(row.title).slice(0, L.evidenceTitle) });
  }
  let k = 0;
  for (const chunk of knowledge.flatMap((r) => r?.chunks ?? [])) {
    if (k >= MAX_KNOWLEDGE) break;
    const url = chunk.sourceUri;
    if (!/^https:\/\//i.test(url) || urls.has(url) || !own.has(siteOf(url))) continue;
    urls.add(url);
    k += 1;
    evidence.push({ id: `K${k}`, kind: "knowledge", text: cut(oneLine(chunk.content), 400), url, title: oneLine(chunk.title || chunk.heading || "").slice(0, L.evidenceTitle) });
  }
  if (product?.ok) {
    product.result.hits.slice(0, MAX_PRODUCT_FACTS).forEach((h, i) => {
      evidence.push({ id: `R${i + 1}`, kind: "product_map", text: cut(oneLine(h.snippet || h.title), 400), url: null, title: oneLine(h.title).slice(0, L.evidenceTitle) });
    });
  }
  const named = new Set<string>();
  let c = 0;
  for (const comp of competitors) {
    named.add(fold(comp.name));
    c += 1;
    const topics = competitorTopics(view, comp.id);
    evidence.push({ id: `C${c}`, kind: "competitor", name: comp.name, text: `${oneLine(comp.name)} (${comp.site}), watched by the brand${topics ? `. Writes most on: ${topics}` : ""}`, url: comp.website, title: oneLine(comp.name) });
  }
  const found = doc?.draft ? competitorsOf(doc.draft) : [];
  for (const f of found) {
    if (named.has(fold(f.name)) || !f.site) continue;
    named.add(fold(f.name));
    c += 1;
    evidence.push({ id: `C${c}`, kind: "competitor", name: f.name, text: `${oneLine(f.name)} (${f.site}), found by the competitor finder`, url: httpsOf(f.site), title: oneLine(f.name) });
  }

  const decided = situations.filter((s) => s.status === "decided").sort((a, b) => b.counts.questions - a.counts.questions || a.order - b.order).slice(0, MAX_SITUATIONS);
  const profile = answeredLabels(tenant?.businessProfile?.answers).map((a) => `${a.short}: ${a.label}`);
  const goals = facts.filter((f) => f.kind === "goal" || f.kind === "timeline").map((f) => `${f.kind === "goal" ? "Goal" : "Timeline"}: ${oneLine(f.text)}`);
  const sources: StrategySource[] = [
    ...(id.statement || id.category ? (["identity"] as const) : []),
    ...(decided.length ? (["situations", "coverage"] as const) : []),
    ...(competitors.length ? (["competitors"] as const) : []),
    ...(found.length ? (["finder"] as const) : []),
    ...(p ? (["site_pages"] as const) : []),
    ...(k ? (["knowledge"] as const) : []),
    ...(product?.ok && product.result.hits.length ? (["product_map"] as const) : []),
    ...(profile.length ? (["profile"] as const) : []),
    ...(goals.length ? (["goal_facts"] as const) : []),
  ];
  return {
    brandName,
    identity: { name: id.name, category: id.category, statement: id.statement, isNot: id.isNot, avoid: id.avoid },
    audiences: map.names.filter((n) => n.kind === "audience").map((n) => n.name).slice(0, L.audiences),
    situations: decided.map((s) => ({ id: s.id, text: s.text, who: s.who, counts: s.counts })),
    profile,
    goals,
    evidence,
    watched: competitors.map((x) => ({ name: x.name, site: x.site || null })),
    sources,
  };
}

/** The prompt, every part fenced as data. */
export function strategyPrompt(input: StrategyInput, today: string): string {
  const i = input.identity;
  const identity = [
    i.name ? `Name: ${i.name}` : "",
    i.category ? `Category: ${i.category}` : "",
    i.statement ? `What it is: ${i.statement}` : "",
    ...i.isNot.map((t) => `It is not: ${t}`),
    ...i.avoid.map((a) => `Words it avoids: ${a.term}${a.useInstead ? ` (says ${a.useInstead})` : ""}`),
  ].filter(Boolean);
  const situations = input.situations.map((s, n) => `S${n + 1}. ${oneLine(s.text)}${s.who ? ` (who: ${oneLine(s.who)})` : ""} [${s.counts.questions} questions, ${s.counts.answered} answered by a live article]`);
  const evidence = input.evidence.map((e) => `${e.id}. ${e.text}${e.url ? ` [page: ${e.title || "untitled"}]` : ""}`);
  return renderPrompt(PROPOSE_PROMPT, {
    brand_name: input.brandName.replace(/["\n]/g, " ").slice(0, 120) || "(not named)",
    category: i.category ? `, in the category "${oneLine(i.category).replace(/"/g, " ").slice(0, 80)}"` : "",
    today,
    identity: fence("brand", identity.join("\n") || "(nothing decided yet)"),
    audiences: fence("audiences", input.audiences.join("\n") || "(none named yet)"),
    situations: fence("situations", situations.join("\n") || "(none decided yet)"),
    profile: fence("profile", [...input.profile, ...input.goals].join("\n") || "(nothing told yet)"),
    evidence: fence("evidence", evidence.join("\n") || "(none)"),
    focus_min: L.focusMin,
    focus_max: L.focusMax,
  });
}

/** A line of copy that keeps to house style and holds no address, or "" when it can't. */
function lineOf(raw: unknown, max: number): string {
  const s = clean(typeof raw === "string" ? raw : "");
  if (!s || s.length > max || hasAddress(s) || dashesIn(s).length || aiTellsIn(s).length) return "";
  return s;
}

const idsOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").map((x) => x.trim().toUpperCase()) : []);

export interface Checked {
  proposal: Omit<ProposedStrategy, "watched" | "sources" | "made">;
  /** What code left out, for the note. */
  dropped: { focus: number; claims: number; isNot: number };
}

/** Check what the model proposed against what it was handed. Pure. */
export function checkStrategy(raw: unknown, input: StrategyInput, at: string): Checked {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const dropped = { focus: 0, claims: 0, isNot: 0 };

  // Focus: S numbers of decided situations, 3 to 5.
  const focus: string[] = [];
  for (const ref of idsOf(r.focus)) {
    const n = Number(/^S(\d{1,3})$/.exec(ref)?.[1]);
    const s = Number.isInteger(n) ? input.situations[n - 1] : undefined;
    if (!s) {
      dropped.focus += 1;
      continue;
    }
    if (!focus.includes(s.id) && focus.length < L.focusMax) focus.push(s.id);
  }
  // Too few: the busiest decided situations fill it (they are listed busiest first).
  for (const s of input.situations) {
    if (focus.length >= Math.min(L.focusMin, input.situations.length)) break;
    if (!focus.includes(s.id)) focus.push(s.id);
  }

  // Claims: proof only from the evidence handed over.
  const byId = new Map(input.evidence.map((e) => [e.id, e] as const));
  const claims: StrategyClaim[] = [];
  const seen = new Set<string>();
  let theirs = 0;
  for (const c of Array.isArray(r.claims) ? (r.claims as Array<Record<string, unknown>>) : []) {
    const text = lineOf(c?.text, L.claimText);
    const side = c?.side === "them" ? "them" : "you";
    const refs = idsOf(c?.proof);
    const valid = refs.map((x) => byId.get(x)).filter((e): e is EvidenceItem => Boolean(e));
    if (!text || seen.has(fold(text)) || (refs.length && !valid.length)) {
      dropped.claims += 1;
      continue;
    }
    let proof: StrategyProof | null = null;
    let competitor: string | null = null;
    if (side === "them") {
      const page = valid.find((e) => e.kind === "competitor");
      const named = typeof c?.competitor === "string" ? (byId.get(c.competitor.trim().toUpperCase()) ?? input.evidence.find((e) => e.kind === "competitor" && fold(e.name) === fold(String(c.competitor)))) : undefined;
      const who = page ?? (named?.kind === "competitor" ? named : undefined);
      // A claim about a competitor names one the brand knows, and stands on their page or is a gap.
      if (!who || (refs.length && !page) || theirs >= MAX_THEIRS) {
        dropped.claims += 1;
        continue;
      }
      theirs += 1;
      competitor = who.name ?? who.title;
      if (page?.url) proof = { kind: "competitor", url: page.url, title: page.title };
    } else {
      const page = valid.find((e) => e.kind === "knowledge") ?? valid.find((e) => e.kind === "site");
      const fromCode = valid.some((e) => e.kind === "product_map");
      // A fact from the code needs a public page or doc that shows it; without one it is a gap.
      if (page?.url) proof = { kind: page.kind === "knowledge" || fromCode ? "product" : "site", url: page.url, title: page.title };
    }
    if (claims.length >= MAX_CLAIMS) break;
    seen.add(fold(text));
    claims.push({ id: newClaimId(), side, text, competitor, proof, proposed: text });
  }

  // What you're not: short, new, and naming a competitor only when the brand knows them.
  const have = new Set(input.identity.isNot.map(fold));
  const isNotProposals: IsNotProposal[] = [];
  for (const x of Array.isArray(r.isNot) ? (r.isNot as Array<Record<string, unknown>>) : []) {
    const text = lineOf(x?.text, L.isNotText);
    if (!text || have.has(fold(text)) || isNotProposals.length >= MAX_IS_NOT) {
      dropped.isNot += 1;
      continue;
    }
    have.add(fold(text));
    const ref = typeof x?.competitor === "string" ? byId.get(x.competitor.trim().toUpperCase()) : undefined;
    isNotProposals.push({ text, why: lineOf(x?.why, L.why), competitor: ref?.kind === "competitor" ? (ref.name ?? ref.title) : null, state: "proposed" });
  }

  // The quarter's goal: started from what the brand's people said, when they said anything.
  const g = (r.goal && typeof r.goal === "object" ? r.goal : {}) as Record<string, unknown>;
  const goalText = lineOf(g.text, L.goalText);
  const measure = lineOf(g.measure, L.measureText);
  const goal: StrategyGoal | null = goalText
    ? { text: goalText, measure, measureKey: measureKeyOf(measure), from: input.profile.length || input.goals.length ? "onboarding" : "vizzy", setAt: at }
    : null;

  return { proposal: { focusSituationIds: focus, audiences: input.audiences, claims, isNotProposals, goal }, dropped };
}

export type ProposeOutcome =
  | { ok: true; doc: BrandStrategyDoc; dropped: Checked["dropped"] }
  | { ok: false; status: number; error: string; current?: BrandStrategyDoc | null };

/** Propose with Vizzy: gather, one model call, check, and save into the draft. */
export async function proposeStrategy(ctx: TenantContext, deps: ProposeDeps = {}): Promise<ProposeOutcome> {
  if (!(deps.modelReady ?? isGeminiConfigured)()) return { ok: false, status: 503, error: "no_model" };
  const input = await gatherStrategyInput(ctx, deps);
  if (!input) return { ok: false, status: 409, error: "no_brand_map" };
  if (!input.identity.statement && !input.identity.category && !input.situations.length) return { ok: false, status: 409, error: "nothing_to_propose" };
  const now = (deps.now ?? (() => new Date()))();
  const tenant = deps.loadTenant ? await deps.loadTenant(ctx.tenantId).catch(() => null) : undefined;
  const usage = deps.usage ?? aiUsage(ctx, "brand_strategy", { db: deps.db, ...(tenant !== undefined ? { tenant } : {}) });
  const raw = await (deps.generate ?? generateTextWithDeadline)(strategyPrompt(input, now.toISOString().slice(0, 10)), {
    timeoutMs: PROPOSE_MS,
    json: true,
    temperature: 0.3,
    thinkingBudget: 1024,
    usage,
  }).catch(() => null);
  const parsed = raw ? parseFirstJson(raw) : null;
  if (!parsed) return { ok: false, status: 502, error: "propose_failed" };
  const { proposal, dropped } = checkStrategy(parsed, input, now.toISOString());
  const saved: StrategyResult<BrandStrategyDoc> = await saveProposal(
    ctx,
    { ...proposal, watched: input.watched, sources: input.sources, made: { promptId: PROPOSE_PROMPT, version: getPrompt(PROPOSE_PROMPT).version, model: TEXT_MODEL } },
    { db: deps.db, now: deps.now },
  );
  if (!saved.ok) return saved;
  return { ok: true, doc: saved.value, dropped };
}
