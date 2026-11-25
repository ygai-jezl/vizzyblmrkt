import { NextResponse } from "next/server";
import { z } from "zod";
import { isGeminiConfigured } from "@/lib/agents/gemini";
import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { fold } from "@/lib/brandMap/changes";
import { listSituations } from "@/lib/brandMap/situations";
import { addBrandMapIsNot, readBrandMap } from "@/lib/brandMap/store";
import { isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors } from "@/lib/competitors/store";
import { answerLabel } from "@/lib/onboarding/choices";
import { listBusinessFacts } from "@/lib/onboarding/store";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { brandMonthlyLimit } from "@/lib/plans/limits";
import { getTenantById, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import type { Competitor } from "@/lib/types/competitor";
import type { Tenant } from "@/lib/types/tenant";
import { BRAND_STRATEGY_LIMITS as L, StrategyEditSchema, competitorsOf, type BrandStrategyDoc, type CompetitorGroupKind, type Strategy, type StrategyCompetitor } from "@/lib/types/brandStrategy";
import { findCompetitors, type FinderDeps } from "./finder";
import { isBrandStrategyEnabled, isCompetitorFinderEnabled } from "./flags";
import { proposeStrategy, type ProposeDeps } from "./propose";
import { approveStrategy, decideIsNot, deleteBrandStrategy, fullRunsInMonth, readBrandStrategyDoc, saveStrategyDraft, type StrategyResult } from "./store";

/**
 * The Strategy tab's APIs (Brand › Brand map › Strategy): origin, switch, sign-in and admin, in that
 * order, as the brand map's. Members read it; admins propose, edit, approve, find competitors,
 * decide what the brand is not and start over.
 */

export const strategyReader = (req: Request) => brandMapReader(req, { on: isBrandStrategyEnabled, offError: "brand_strategy_disabled" });
export const strategyAdmin = (req: Request) => brandMapAdmin(req, { on: isBrandStrategyEnabled, offError: "brand_strategy_disabled" });
export const finderAdmin = (req: Request) => brandMapAdmin(req, { on: isCompetitorFinderEnabled, offError: "competitor_finder_disabled" });

/** Propose with Vizzy: one model call, a few an hour per brand. */
export const PROPOSE_LIMIT = { prefix: "strategy_propose", burstLimit: 2, hourlyLimit: 6 };
/** The competitor finder: up to four grounded searches a run. */
export const FIND_LIMIT = { prefix: "strategy_find", burstLimit: 2, hourlyLimit: 6 };

export interface ViewDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

/** A situation as the tab shows it. */
export interface ViewSituation {
  id: string;
  text: string;
  focus: boolean;
  questions: number;
  answered: number;
}

/** A competitor as the tab shows it: watched on Brand › Competitors or not. */
export type ViewCompetitor = StrategyCompetitor & { group: CompetitorGroupKind; monitored: boolean };

export interface StrategyView {
  rev: number;
  /** none: no strategy yet; draft: never approved; approved: the draft is what is approved; changed: edited since it was approved. */
  state: "none" | "draft" | "approved" | "changed";
  draft: Strategy | null;
  approved: { at: string; by: string | null } | null;
  situations: ViewSituation[];
  competitors: ViewCompetitor[];
  identity: { category: string; statement: string; isNot: string[]; avoid: Array<{ term: string; useInstead: string }> };
  /** Where the goal starts: what the brand wants first, and the goals its people told Vizzy. */
  goalStart: { want: string; goals: string[] };
  finder: { on: boolean; granted: boolean; quickUsed: boolean; used: number; limit: number | null };
  canPropose: boolean;
  canMonitor: boolean;
}

const MAX_SITUATIONS = 200;
const noStore = { "cache-control": "no-store" };

/** The draft and the approved strategy say the same, whoever saved them when. */
export function sameStrategy(a: Strategy | null, b: Strategy | null): boolean {
  if (!a || !b) return false;
  const strip = (s: Strategy) => JSON.stringify({ ...s, at: "", by: null });
  return strip(a) === strip(b);
}

function stateOf(doc: BrandStrategyDoc | null): StrategyView["state"] {
  if (!doc || (!doc.draft && !doc.approved)) return "none";
  if (!doc.approved) return "draft";
  return sameStrategy(doc.draft, doc.approved) || !doc.draft ? "approved" : "changed";
}

/** Whether a competitor in the strategy is one the brand watches, by site or name. */
export function isMonitored(c: Pick<StrategyCompetitor, "name" | "site">, watched: Array<Pick<Competitor, "name" | "site">>): boolean {
  return watched.some((w) => (c.site && w.site === c.site) || fold(w.name) === fold(c.name));
}

/** Everything the Strategy tab shows, for any member of the brand. */
export async function strategyView(ctx: TenantContext, deps: ViewDeps = {}): Promise<StrategyView> {
  const load = deps.loadTenant ?? getTenantById;
  const [doc, read, situations, watched, tenant, facts] = await Promise.all([
    readBrandStrategyDoc(ctx, deps).catch(() => null),
    readBrandMap(ctx, deps.db).catch(() => null),
    listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]),
    listCompetitors(ctx, { db: deps.db }).catch(() => [] as Competitor[]),
    load(ctx.tenantId).catch(() => null),
    // The goals a brand's people told Vizzy are their own words: admins see them, as in About your business.
    ctx.role === "admin" ? listBusinessFacts(ctx, { db: deps.db }).catch(() => []) : Promise.resolve([]),
  ]);
  const draft = doc?.draft ?? doc?.approved ?? null;
  const focus = new Set(draft?.focusSituationIds ?? []);
  const identity = read?.state === "ok" ? read.map.identity : null;
  const finderOn = isCompetitorFinderEnabled();
  const granted = finderOn ? await brandCanUse(ctx, "competitor_finder", load).catch(() => false) : false;
  const limit = finderOn && granted ? await brandMonthlyLimit(ctx, "competitor_finder", load).catch(() => null) : null;
  const canMonitor = isCompetitorsEnabled() && (await brandCanUse(ctx, "competitors", load).catch(() => false));
  return {
    rev: doc?.rev ?? 0,
    state: stateOf(doc),
    draft,
    approved: doc?.approved ? { at: doc.approved.at, by: doc.approved.by } : null,
    situations: situations
      .filter((s) => s.status === "decided")
      .sort((a, b) => Number(focus.has(b.id)) - Number(focus.has(a.id)) || b.counts.questions - a.counts.questions || a.order - b.order)
      .slice(0, MAX_SITUATIONS)
      .map((s) => ({ id: s.id, text: s.text, focus: focus.has(s.id), questions: s.counts.questions, answered: s.counts.answered })),
    competitors: draft ? competitorsOf(draft).map((c) => ({ ...c, monitored: isMonitored(c, watched) })) : [],
    identity: identity ? { category: identity.category, statement: identity.statement, isNot: identity.isNot, avoid: identity.avoid } : { category: "", statement: "", isNot: [], avoid: [] },
    goalStart: {
      want: answerLabel("want", tenant?.businessProfile?.answers.want),
      goals: facts.filter((f) => f.kind === "goal").map((f) => f.text).slice(0, 5),
    },
    finder: { on: finderOn, granted, quickUsed: Boolean(doc?.finder.quickAt), used: fullRunsInMonth(doc, (deps.now ?? (() => new Date()))()), limit },
    canPropose: isGeminiConfigured(),
    canMonitor,
  };
}

function fail(r: { status: number; error: string; current?: BrandStrategyDoc | null }): Response {
  return NextResponse.json({ error: r.error }, { status: r.status });
}

async function answer(ctx: TenantContext, r: StrategyResult<unknown>, deps: ViewDeps, extra: Record<string, unknown> = {}): Promise<Response> {
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, ...extra, strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

/** GET: the tab. */
export async function viewFromRequest(ctx: TenantContext, deps: ViewDeps = {}): Promise<Response> {
  return NextResponse.json({ strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

/** PUT: a person's edit of the draft. Focus situations must be the brand's decided ones. */
export async function saveFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = StrategyEditSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (parsed.data.focusSituationIds?.length) {
    const decided = new Set((await listSituations(ctx, { db: deps.db })).filter((s) => s.status === "decided").map((s) => s.id));
    if (parsed.data.focusSituationIds.some((id) => !decided.has(id))) return NextResponse.json({ error: "unknown_situation" }, { status: 400 });
  }
  return answer(ctx, await saveStrategyDraft(ctx, parsed.data, deps), deps);
}

const ApproveBody = z.object({ baseRev: z.number().int().min(0) }).strict();

/** POST approve: the draft becomes what the writer, research, Next up and Vizzy read. */
export async function approveFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = ApproveBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return answer(ctx, await approveStrategy(ctx, parsed.data, deps), deps);
}

/** POST propose: Vizzy drafts the strategy. Nothing approved changes. */
export async function proposeFromRequest(ctx: TenantContext, deps: ProposeDeps & ViewDeps = {}): Promise<Response> {
  const r = await proposeStrategy(ctx, deps);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, dropped: r.dropped, strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

const FindBody = z.object({ mode: z.enum(["quick", "full"]) }).strict();

/** POST find: the competitor finder, quick or full. What it finds waits in the draft for a tick. */
export async function findFromRequest(ctx: TenantContext, body: unknown, deps: FinderDeps & ViewDeps = {}): Promise<Response> {
  const parsed = FindBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await findCompetitors(ctx, parsed.data, deps);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, found: r.found, mode: r.mode, strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

const IsNotBody = z.object({ baseRev: z.number().int().min(0), text: z.string().trim().min(1).max(L.isNotText), accept: z.boolean() }).strict();

/** POST is-not: Add puts the line in the brand map's identity (Who you are); No keeps it from coming back. */
export async function isNotFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = IsNotBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const doc = await readBrandStrategyDoc(ctx, deps);
  if (!doc || doc.rev !== parsed.data.baseRev) return fail({ status: 409, error: doc ? "strategy_changed" : "no_proposal" });
  const proposal = doc.draft?.isNotProposals.find((x) => fold(x.text) === fold(parsed.data.text));
  if (!proposal) return fail({ status: 404, error: "no_proposal" });
  if (parsed.data.accept) {
    const added = await addBrandMapIsNot(ctx, { text: proposal.text }, { db: deps.db, nowMs: deps.now?.().getTime() });
    if (!added.ok) return NextResponse.json({ error: added.error, ...(added.issues ? { issues: added.issues } : {}) }, { status: added.status });
  }
  return answer(ctx, await decideIsNot(ctx, parsed.data, deps), deps);
}

/** DELETE: start over. The strategy, its history and its decisions go; the brand map's stars stay. */
export async function deleteFromRequest(ctx: TenantContext, deps: ViewDeps = {}): Promise<Response> {
  await deleteBrandStrategy(ctx, deps);
  return NextResponse.json({ ok: true, strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

/** Limits for the routes that spend: a brand's own counter. */
export async function overLimit(ctx: TenantContext, limit: typeof PROPOSE_LIMIT, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  return isRateLimited(`tenant:${ctx.tenantId}`, limit, { db: deps.db });
}
