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
import { liveCompetitors, suggestionsOf, type LiveCompetitor } from "./competitors";
import { findCompetitors, type FinderDeps } from "./finder";
import { isBrandStrategyEnabled, isCompetitorFinderEnabled, isStrategyCompetitorsEnabled } from "./flags";
import { proposeStrategy, type ProposeDeps } from "./propose";
import { approveStrategy, decideIsNot, deleteBrandStrategy, dismissFound, fullRunsInMonth, readBrandStrategyDoc, saveStrategyDraft, undoIsNot, type StrategyResult } from "./store";

/**
 * The Strategy tab's APIs (Brand › Brand map › Strategy): origin, switch, sign-in and admin, in that
 * order, as the brand map's. Members read it; admins propose, edit, approve, find competitors,
 * decide what the brand is not and start over.
 */

export const strategyReader = (req: Request) => brandMapReader(req, { on: isBrandStrategyEnabled, offError: "brand_strategy_disabled" });
export const strategyAdmin = (req: Request) => brandMapAdmin(req, { on: isBrandStrategyEnabled, offError: "brand_strategy_disabled" });
export const finderAdmin = (req: Request) => brandMapAdmin(req, { on: isCompetitorFinderEnabled, offError: "competitor_finder_disabled" });
export const joinedReader = (req: Request) => brandMapReader(req, { on: isStrategyCompetitorsEnabled, offError: "strategy_competitors_disabled" });
export const joinedAdmin = (req: Request) => brandMapAdmin(req, { on: isStrategyCompetitorsEnabled, offError: "strategy_competitors_disabled" });

/** Propose with Vizzy: one model call, a few an hour per brand. */
export const PROPOSE_LIMIT = { prefix: "strategy_propose", burstLimit: 2, hourlyLimit: 6 };
/** The competitor finder: up to four grounded searches a run. */
export const FIND_LIMIT = { prefix: "strategy_find", burstLimit: 2, hourlyLimit: 6 };

export interface ViewDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

/** Whether the competitor finder can run for the brand, and how many full runs it has left. */
export interface FinderState {
  on: boolean;
  granted: boolean;
  quickUsed: boolean;
  used: number;
  limit: number | null;
}

/** One of the finder's suggestions, as both doors show it. */
export type Suggestion = Pick<LiveCompetitor, "name" | "site" | "group" | "foundTimes" | "evidence">;

/** A situation as the tab shows it. */
export interface ViewSituation {
  id: string;
  text: string;
  focus: boolean;
  questions: number;
  answered: number;
}

/**
 * A competitor as the tab shows it: watched on Brand › Competitors or not. Joined to Competitors
 * (STRATEGY_COMPETITORS_ENABLED), `id` is its record when watched and `group` is null for one
 * nobody has grouped yet; off, every one has the group the strategy gave it.
 */
export type ViewCompetitor = StrategyCompetitor & { id?: string | null; group: CompetitorGroupKind | null; monitored: boolean };

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
  finder: FinderState;
  canPropose: boolean;
  canMonitor: boolean;
  /** The strategy joined to Competitors (STRATEGY_COMPETITORS_ENABLED): the live list, groups and Not a competitor. */
  joined: boolean;
}

const MAX_SITUATIONS = 200;
const noStore = { "cache-control": "no-store" };

/**
 * The draft and the approved strategy say the same, whoever saved them when. `ignoreCompetitors`
 * (the strategy joined to Competitors): the competitor list is live, so a competitor watched,
 * grouped or found since approving never marks the strategy changed.
 */
export function sameStrategy(a: Strategy | null, b: Strategy | null, ignoreCompetitors = false): boolean {
  if (!a || !b) return false;
  const strip = (s: Strategy) => JSON.stringify({ ...s, at: "", by: null, ...(ignoreCompetitors ? { competitorGroups: [], ungrouped: [] } : {}) });
  return strip(a) === strip(b);
}

function stateOf(doc: BrandStrategyDoc | null, joined: boolean): StrategyView["state"] {
  if (!doc || (!doc.draft && !doc.approved)) return "none";
  if (!doc.approved) return "draft";
  return sameStrategy(doc.draft, doc.approved, joined) || !doc.draft ? "approved" : "changed";
}

/** The finder for this brand: on, included, its one quick answer used, and full runs this month. */
export async function finderState(
  ctx: TenantContext,
  doc: BrandStrategyDoc | null,
  deps: { now?: () => Date },
  load: (id: string) => Promise<Tenant | null>,
): Promise<FinderState> {
  const on = isCompetitorFinderEnabled();
  const granted = on ? await brandCanUse(ctx, "competitor_finder", load).catch(() => false) : false;
  const limit = on && granted ? await brandMonthlyLimit(ctx, "competitor_finder", load).catch(() => null) : null;
  return { on, granted, quickUsed: Boolean(doc?.finder.quickAt), used: fullRunsInMonth(doc, (deps.now ?? (() => new Date()))()), limit };
}

/**
 * Brand › Competitors as the second door (STRATEGY_COMPETITORS_ENABLED): the finder's suggestions
 * that aren't watched or marked Not a competitor, and whether the finder can run. Null while off.
 */
export async function competitorsDoor(ctx: TenantContext, watched: Competitor[], deps: ViewDeps = {}): Promise<{ suggestions: Suggestion[]; finder: FinderState } | null> {
  if (!isStrategyCompetitorsEnabled()) return null;
  const [doc, tenant] = await Promise.all([readBrandStrategyDoc(ctx, deps).catch(() => null), (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null)]);
  const draft = doc?.draft ?? doc?.approved ?? null;
  const suggestions = suggestionsOf(liveCompetitors(draft, watched, doc?.finder.notCompetitors ?? [])).map(({ name, site, group, foundTimes, evidence }) => ({ name, site, group, foundTimes, evidence }));
  return { suggestions, finder: await finderState(ctx, doc, deps, async () => tenant) };
}

/**
 * The brand's watched competitors for the live list, or null when it doesn't have Competitors. A
 * read that fails throws: an empty list would read as "watches none" and be kept as such.
 */
export async function watchedFor(ctx: TenantContext, deps: { db?: FirestoreLike }, load: (id: string) => Promise<Tenant | null>): Promise<Competitor[] | null> {
  if (!isCompetitorsEnabled() || !(await brandCanUse(ctx, "competitors", load))) return null;
  return listCompetitors(ctx, { db: deps.db });
}

/** Whether a competitor in the strategy is one the brand watches, by site or name. */
export function isMonitored(c: Pick<StrategyCompetitor, "name" | "site">, watched: Array<Pick<Competitor, "name" | "site">>): boolean {
  return watched.some((w) => (c.site && w.site === c.site) || fold(w.name) === fold(c.name));
}

/** Everything the Strategy tab shows, for any member of the brand. */
export async function strategyView(ctx: TenantContext, deps: ViewDeps = {}): Promise<StrategyView> {
  const [doc, read, situations, watched, tenant, facts] = await Promise.all([
    readBrandStrategyDoc(ctx, deps).catch(() => null),
    readBrandMap(ctx, deps.db).catch(() => null),
    listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]),
    listCompetitors(ctx, { db: deps.db }).catch(() => [] as Competitor[]),
    (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null),
    // The goals a brand's people told Vizzy are their own words: admins see them, as in About your business.
    ctx.role === "admin" ? listBusinessFacts(ctx, { db: deps.db }).catch(() => []) : Promise.resolve([]),
  ]);
  const draft = doc?.draft ?? doc?.approved ?? null;
  const focus = new Set(draft?.focusSituationIds ?? []);
  const identity = read?.state === "ok" ? read.map.identity : null;
  // The brand record is read once, for every plan check below.
  const load = async () => tenant;
  const finder = await finderState(ctx, doc, deps, load);
  const canMonitor = isCompetitorsEnabled() && (await brandCanUse(ctx, "competitors", load).catch(() => false));
  const joined = isStrategyCompetitorsEnabled();
  return {
    rev: doc?.rev ?? 0,
    state: stateOf(doc, joined),
    draft,
    approved: doc?.approved ? { at: doc.approved.at, by: doc.approved.by } : null,
    situations: situations
      .filter((s) => s.status === "decided")
      .sort((a, b) => Number(focus.has(b.id)) - Number(focus.has(a.id)) || b.counts.questions - a.counts.questions || a.order - b.order)
      .slice(0, MAX_SITUATIONS)
      .map((s) => ({ id: s.id, text: s.text, focus: focus.has(s.id), questions: s.counts.questions, answered: s.counts.answered })),
    // Joined: every watched competitor at once, before any Propose too, then the finder's suggestions.
    competitors: joined
      ? liveCompetitors(draft, canMonitor ? watched : null, doc?.finder.notCompetitors ?? [])
      : draft
        ? competitorsOf(draft).map((c) => ({ ...c, monitored: isMonitored(c, watched) }))
        : [],
    identity: identity ? { category: identity.category, statement: identity.statement, isNot: identity.isNot, avoid: identity.avoid } : { category: "", statement: "", isNot: [], avoid: [] },
    goalStart: {
      want: answerLabel("want", tenant?.businessProfile?.answers.want),
      goals: facts.filter((f) => f.kind === "goal").map((f) => f.text).slice(0, 5),
    },
    finder,
    canPropose: isGeminiConfigured(),
    canMonitor,
    joined,
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

/**
 * POST approve: the draft becomes what the writer, research, Next up and Vizzy read. When some
 * stars couldn't be changed on the brand map, `starsNotUpdated` names those situations.
 */
export async function approveFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = ApproveBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // Joined: the approved copy keeps the live list, so the competitors are read first. If they can't
  // be, nothing is approved: a copy without them would be kept, with every find logged as left out.
  let watched: { watched?: Competitor[] | null } = {};
  if (isStrategyCompetitorsEnabled()) {
    const list = await watchedFor(ctx, deps, deps.loadTenant ?? getTenantById).then(
      (w) => ({ ok: true as const, w }),
      () => ({ ok: false as const }),
    );
    if (!list.ok) return NextResponse.json({ error: "competitors_unreadable" }, { status: 503 });
    watched = { watched: list.w };
  }
  const r = await approveStrategy(ctx, { ...parsed.data, ...watched }, deps);
  if (!r.ok || !r.starsNotUpdated?.length) return answer(ctx, r, deps);
  const view = await strategyView(ctx, deps);
  const missed = new Set(r.starsNotUpdated);
  const texts = view.situations.filter((s) => missed.has(s.id)).map((s) => s.text);
  return NextResponse.json({ ok: true, starsNotUpdated: texts.length ? texts : r.starsNotUpdated, strategy: view }, { headers: noStore });
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
  return NextResponse.json({ ok: true, found: r.found, mode: r.mode, ...(r.gapSkipped ? { gapSkipped: true } : {}), strategy: await strategyView(ctx, deps) }, { headers: noStore });
}

const IsNotBody = z.object({ baseRev: z.number().int().min(0), text: z.string().trim().min(1).max(L.isNotText), accept: z.boolean() }).strict();

/** POST is-not: Add puts the line in the brand map's identity (Who you are); No keeps it from coming back. */
export async function isNotFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = IsNotBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // The strategy's change comes first (its revision, and the line still waiting); only then does an
  // accepted line go into the brand map, and if that fails the strategy's change is given back.
  const decided = await decideIsNot(ctx, parsed.data, deps);
  if (!decided.ok || !parsed.data.accept) return answer(ctx, decided, deps);
  const text = decided.value.draft?.isNotProposals.find((x) => fold(x.text) === fold(parsed.data.text))?.text ?? parsed.data.text;
  const added = await addBrandMapIsNot(ctx, { text }, { db: deps.db, nowMs: deps.now?.().getTime() }).catch(() => ({ ok: false as const, status: 500, error: "not_saved", issues: undefined }));
  if (added.ok) return answer(ctx, decided, deps);
  await undoIsNot(ctx, { text }, deps).catch(() => null);
  return NextResponse.json({ error: added.error, ...(added.issues ? { issues: added.issues } : {}) }, { status: added.status });
}

const NotBody = z
  .object({ name: z.string().trim().min(1).max(L.competitorName), site: z.string().trim().min(1).max(253).nullable().default(null) })
  .strict();

/** POST competitors/not: Not a competitor. The finder never suggests it again; the decision is kept. */
export async function notCompetitorFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = NotBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return answer(ctx, await dismissFound(ctx, parsed.data, deps), deps);
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
