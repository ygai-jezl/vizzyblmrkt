import { randomBytes } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { fold } from "@/lib/brandMap/changes";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import {
  BRAND_STRATEGY_LIMITS as L,
  BrandStrategyDocSchema,
  StrategySchema,
  brandStrategyDocId,
  competitorsOf,
  emptyStrategy,
  groupsOf,
  type BrandStrategyDoc,
  type CompetitorGroupKind,
  type IsNotProposal,
  type Strategy,
  type StrategyClaim,
  type StrategyCompetitor,
  type StrategyDecision,
  type StrategyDecisionKind,
  type StrategyEdit,
  type StrategyGoal,
  type StrategyMade,
  type StrategySource,
} from "@/lib/types/brandStrategy";
import { isBrandStrategyEnabled } from "./flags";

export type {
  BrandStrategyDoc,
  CompetitorGroupKind,
  IsNotProposal,
  Strategy,
  StrategyClaim,
  StrategyCompetitor,
  StrategyDecision,
  StrategyGoal,
  StrategyMade,
  StrategySource,
} from "@/lib/types/brandStrategy";
export { claimShown, competitorsOf, groupsOf, COMPETITOR_GROUP_KINDS, COMPETITOR_GROUP_LABEL } from "@/lib/types/brandStrategy";

/**
 * The brand strategy's storage (BRAND_STRATEGY_ENABLED): one document per brand,
 * `brand_strategy/bst_<tenantId>`, in its region, through forTenant(ctx).
 *
 *  - A person EDITS the draft from the Strategy tab, naming the revision they started from; an
 *    edit over someone else's is refused with the record as it is now (409 `strategy_changed`).
 *  - Propose with Vizzy and the competitor finder write the draft too, and move `rev`, so a person
 *    with an older copy open is told rather than overwriting them.
 *  - APPROVE copies the draft to `approved` (what the writer, research, Next up and Vizzy read),
 *    keeps the last 5 approved in `history`, and stars the focus situations on the brand map.
 *  - Every star, tick, edit and isNot a person decides is kept in `decisions` (200 at most, newest
 *    first) for the learning loops. Nothing learns from them yet.
 *
 * Piece 2 (content strategy) reads the approved strategy with `readBrandStrategy`.
 */

export interface StrategyDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

export type StrategyResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; current?: BrandStrategyDoc | null };

const repoOf = (ctx: TenantContext, deps: StrategyDeps) => forTenant(ctx, deps.db).brandStrategy;
const nowIso = (deps: StrategyDeps) => (deps.now ?? (() => new Date()))().toISOString();
const byOf = (ctx: TenantContext) => ctx.email ?? ctx.userId ?? null;
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

class Refused extends Error {
  constructor(readonly status: number, readonly error: string, readonly current: BrandStrategyDoc | null = null) {
    super(error);
  }
}

/** A new claim's id. */
export function newClaimId(): string {
  return `cl_${randomBytes(8).toString("hex")}`;
}

/** A stored document as the app reads it, or null when it no longer reads. */
export function parseBrandStrategy(raw: Record<string, unknown> | null): BrandStrategyDoc | null {
  if (!raw) return null;
  const r = BrandStrategyDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The whole record (draft, approved, history, decisions), whatever the switch says. */
export async function readBrandStrategyDoc(ctx: TenantContext, deps: StrategyDeps = {}): Promise<BrandStrategyDoc | null> {
  return parseBrandStrategy(await repoOf(ctx, deps).getById(brandStrategyDocId(ctx.tenantId)));
}

/**
 * The brand's APPROVED strategy, the one everything reads (the context pack, Next up, Vizzy, and
 * piece 2's content strategy). Null with BRAND_STRATEGY_ENABLED off, when none is approved yet,
 * or when the record can't be read: the reader then works exactly as before. `at` and `by` say
 * when and by whom it was approved.
 */
export async function readBrandStrategy(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<Strategy | null> {
  if (!isBrandStrategyEnabled()) return null;
  const doc = await readBrandStrategyDoc(ctx, deps).catch(() => null);
  return doc?.approved ?? null;
}

function emptyDoc(tenantId: string, now: string) {
  return {
    rev: 0,
    draft: null as Strategy | null,
    approved: null as Strategy | null,
    history: [] as Strategy[],
    decisions: [] as StrategyDecision[],
    finder: { quickAt: null as string | null, fullRuns: [] as string[] },
    createdAt: now,
    updatedAt: now,
    id: brandStrategyDocId(tenantId),
    tenantId,
  };
}

/** Newest first, at most 200. Pure. */
export function withDecisions(existing: StrategyDecision[], added: StrategyDecision[]): StrategyDecision[] {
  return [...added, ...existing].slice(0, L.decisions);
}

type Patch = Partial<Omit<BrandStrategyDoc, "id" | "tenantId" | "createdAt">>;
type Plan = (doc: BrandStrategyDoc, created: boolean) => Patch | null;

/**
 * Change the record in one transaction: `plan` sees it as it is now (an empty one when there is
 * none) and returns what to change, null to change nothing, or throws Refused. Every change moves
 * `rev` and `updatedAt`.
 */
async function change(ctx: TenantContext, deps: StrategyDeps, plan: Plan): Promise<StrategyResult<BrandStrategyDoc>> {
  const now = nowIso(deps);
  const id = brandStrategyDocId(ctx.tenantId);
  try {
    const { doc } = await repoOf(ctx, deps).upsert(
      id,
      () => {
        const base = emptyDoc(ctx.tenantId, now);
        const patch = plan(BrandStrategyDocSchema.parse(base), true);
        // Nothing to make: refuse rather than create an empty record.
        if (!patch) throw new Refused(404, "no_strategy");
        const { id: _i, tenantId: _t, ...rest } = { ...base, ...patch, rev: 1, updatedAt: now };
        void _i;
        void _t;
        return rest;
      },
      (current) => {
        const parsed = parseBrandStrategy(current);
        if (!parsed) throw new Refused(409, "strategy_unreadable");
        const patch = plan(parsed, false);
        if (!patch) return null;
        return { ...patch, rev: parsed.rev + 1, updatedAt: now };
      },
    );
    const parsed = parseBrandStrategy(doc);
    return parsed ? { ok: true, value: parsed } : { ok: false, status: 409, error: "strategy_unreadable" };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, status: err.status, error: err.error, current: err.current };
    throw err;
  }
}

const decision = (kind: StrategyDecisionKind, ref: string, at: string, by: string | null, before: string | null = null, after: string | null = null): StrategyDecision => ({
  kind,
  ref: clip(ref, L.decisionText),
  before: before === null ? null : clip(before, L.decisionText),
  after: after === null ? null : clip(after, L.decisionText),
  at,
  by,
});

/** The meaning of a goal's measure when YouGrow knows it: its key or its name, any case. */
export function measureKeyOf(words: string): MeaningKey | null {
  const w = fold(words);
  if (!w) return null;
  for (const [key, m] of Object.entries(MEANINGS) as Array<[MeaningKey, { name: string }]>) {
    if (fold(key) === w || fold(m.name) === w) return key;
  }
  return null;
}

/**
 * What a person's edit decided, comparing the draft before and after: stars added or removed,
 * competitors ticked or unticked, claims added, edited (before and after) or removed, and the goal
 * set. Pure.
 */
export function editDecisions(before: Strategy, after: Strategy, at: string, by: string | null): StrategyDecision[] {
  const out: StrategyDecision[] = [];
  const was = new Set(before.focusSituationIds);
  const now = new Set(after.focusSituationIds);
  for (const id of after.focusSituationIds) if (!was.has(id)) out.push(decision("star_added", id, at, by));
  for (const id of before.focusSituationIds) if (!now.has(id)) out.push(decision("star_removed", id, at, by));
  const ticks = new Map(competitorsOf(before).map((c) => [fold(c.name), c.ticked] as const));
  for (const c of competitorsOf(after)) {
    const prior = ticks.get(fold(c.name));
    if (prior !== undefined && prior !== c.ticked) out.push(decision(c.ticked ? "competitor_ticked" : "competitor_unticked", c.name, at, by));
  }
  const claims = new Map(before.claims.map((c) => [c.id, c] as const));
  for (const c of after.claims) {
    const prior = claims.get(c.id);
    if (!prior) out.push(decision("claim_added", c.id, at, by, null, c.text));
    else if (prior.text !== c.text) out.push(decision("claim_edited", c.id, at, by, prior.text, c.text));
  }
  const kept = new Set(after.claims.map((c) => c.id));
  for (const c of before.claims) if (!kept.has(c.id)) out.push(decision("claim_removed", c.id, at, by, c.text, null));
  const goal = (g: StrategyGoal | null) => (g ? `${g.text}${g.measure ? ` | ${g.measure}` : ""}` : "");
  if (goal(before.goal) !== goal(after.goal)) out.push(decision("goal_set", "goal", at, by, goal(before.goal) || null, goal(after.goal) || null));
  return out;
}

/** Apply a person's edit to a draft. Pure: the caller has checked the situation ids. */
export function applyEdit(draft: Strategy, edit: Omit<StrategyEdit, "baseRev">, at: string, by: string | null): Strategy {
  const next: Strategy = structuredClone(draft);
  if (edit.focusSituationIds) next.focusSituationIds = [...new Set(edit.focusSituationIds)].slice(0, L.focusMax);
  if (edit.audiences) next.audiences = [...new Map(edit.audiences.map((a) => [fold(a), clip(a, L.audienceText)] as const)).values()].filter(Boolean).slice(0, L.audiences);
  if (edit.ticked) {
    const ticks = new Map(edit.ticked.map((t) => [fold(t.name), t.ticked] as const));
    next.competitorGroups = groupsOf(competitorsOf(next).map((c) => (ticks.has(fold(c.name)) ? { ...c, ticked: ticks.get(fold(c.name))! } : c)));
  }
  if (edit.claims) {
    const prior = new Map(draft.claims.map((c) => [c.id, c] as const));
    next.claims = edit.claims.slice(0, L.claims).map((c): StrategyClaim => {
      const was = c.id ? prior.get(c.id) : undefined;
      const competitor = c.side === "them" ? clip(c.competitor ?? was?.competitor ?? "", L.competitorName) || null : null;
      if (!was) return { id: newClaimId(), side: c.side, text: clip(c.text, L.claimText), competitor, proof: null, proposed: null };
      return { ...was, side: c.side, text: clip(c.text, L.claimText), competitor };
    });
  }
  if (edit.goal !== undefined) {
    const same = edit.goal && draft.goal && draft.goal.text === edit.goal.text && draft.goal.measure === edit.goal.measure;
    next.goal = !edit.goal
      ? null
      : same
        ? draft.goal
        : { text: clip(edit.goal.text, L.goalText), measure: clip(edit.goal.measure, L.measureText), measureKey: measureKeyOf(edit.goal.measure), from: "person", setAt: at };
  }
  next.at = at;
  next.by = by;
  return StrategySchema.parse(next);
}

/**
 * Save a person's edit of the draft. Refused when the record changed since they opened it (409
 * `strategy_changed`, with the record now) or there is no draft to edit (409 `no_draft`).
 */
export async function saveStrategyDraft(ctx: TenantContext, edit: StrategyEdit, deps: StrategyDeps = {}): Promise<StrategyResult<BrandStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  const { baseRev, ...parts } = edit;
  return change(ctx, deps, (doc, created) => {
    if (created || doc.rev !== baseRev) throw new Refused(409, created ? "no_draft" : "strategy_changed", created ? null : doc);
    const draft = doc.draft ?? emptyStrategy(at, by);
    const next = applyEdit(draft, parts, at, by);
    return { draft: next, decisions: withDecisions(doc.decisions, editDecisions(draft, next, at, by)) };
  });
}

/** What Propose with Vizzy hands the store: the parts it proposes, checked. */
export interface ProposedStrategy {
  focusSituationIds: string[];
  audiences: string[];
  claims: StrategyClaim[];
  isNotProposals: IsNotProposal[];
  goal: StrategyGoal | null;
  /** Competitors the brand already watches, added to the draft as ticked. */
  watched: Array<{ name: string; site: string | null }>;
  sources: StrategySource[];
  made: StrategyMade;
}

/**
 * Put a proposal in the draft. What a person decided stays: a goal they set, claims they wrote,
 * isNot lines they accepted or declined, and the competitors and ticks already there. Pure.
 */
export function mergeProposal(draft: Strategy | null, p: ProposedStrategy, at: string, by: string | null): Strategy {
  const base = draft ?? emptyStrategy(at, by);
  const own = base.claims.filter((c) => c.proposed === null);
  const decidedNot = base.isNotProposals.filter((x) => x.state !== "proposed");
  const seen = new Set(decidedNot.map((x) => fold(x.text)));
  const fresh = p.isNotProposals.filter((x) => !seen.has(fold(x.text)));
  const list = competitorsOf(base);
  const known = new Set(list.map((c) => fold(c.name)));
  const sites = new Set(list.flatMap((c) => (c.site ? [c.site] : [])));
  for (const w of p.watched) {
    if (known.has(fold(w.name)) || (w.site && sites.has(w.site))) continue;
    known.add(fold(w.name));
    list.push({ name: clip(w.name, L.competitorName), site: w.site, foundTimes: 0, evidence: [], ticked: true, from: "watched", group: "most" });
  }
  return StrategySchema.parse({
    ...base,
    focusSituationIds: p.focusSituationIds.slice(0, L.focusMax),
    proposedFocusIds: p.focusSituationIds.slice(0, L.focusMax),
    audiences: p.audiences.slice(0, L.audiences),
    competitorGroups: groupsOf(list),
    claims: [...p.claims, ...own].slice(0, L.claims),
    isNotProposals: [...decidedNot, ...fresh].slice(0, L.isNot),
    goal: base.goal && base.goal.from === "person" ? base.goal : (p.goal ?? base.goal),
    sources: p.sources,
    made: p.made,
    at,
    by,
  });
}

/** Save what Propose with Vizzy proposed into the draft (the record is made if there is none). */
export async function saveProposal(ctx: TenantContext, p: ProposedStrategy, deps: StrategyDeps = {}): Promise<StrategyResult<BrandStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  return change(ctx, deps, (doc) => ({ draft: mergeProposal(doc.draft, p, at, by) }));
}

/** One competitor the finder found, in its group. */
export type FoundCompetitor = StrategyCompetitor & { group: CompetitorGroupKind };

/**
 * Put what the competitor finder found in the draft. The latest run replaces the last one's
 * finds, but a competitor a person ticked, one the brand watches or one a person added stays,
 * with its tick. Pure.
 */
export function mergeFound(draft: Strategy | null, found: FoundCompetitor[], at: string, by: string | null): Strategy {
  const base = draft ?? emptyStrategy(at, by);
  const prior = competitorsOf(base);
  const ticks = new Map(prior.map((c) => [fold(c.name), c] as const));
  const next: FoundCompetitor[] = found.map((f) => {
    const was = ticks.get(fold(f.name));
    return was ? { ...f, ticked: was.ticked, from: was.from === "finder" ? "finder" : was.from, site: f.site ?? was.site } : f;
  });
  const have = new Set(next.map((c) => fold(c.name)));
  for (const c of prior) if (!have.has(fold(c.name)) && (c.ticked || c.from !== "finder")) next.push(c);
  const sources = [...new Set([...base.sources, "finder" as const])];
  return StrategySchema.parse({ ...base, competitorGroups: groupsOf(next), sources, at, by });
}

/** Full runs this calendar month (UTC), for the competitor_finder cap. Pure. */
export function fullRunsInMonth(doc: Pick<BrandStrategyDoc, "finder"> | null, now: Date): number {
  const month = now.toISOString().slice(0, 7);
  return (doc?.finder.fullRuns ?? []).filter((at) => at.startsWith(month)).length;
}

/** Full competitor finder runs this calendar month, against the competitor_finder cap. */
export async function finderRunsThisMonth(ctx: TenantContext, deps: StrategyDeps = {}): Promise<number> {
  return fullRunsInMonth(await readBrandStrategyDoc(ctx, deps), (deps.now ?? (() => new Date()))());
}

/** Save what a finder run found, and count the run (`quick` once per brand, `full` against the month). */
export async function saveFound(ctx: TenantContext, input: { mode: "quick" | "full"; found: FoundCompetitor[] }, deps: StrategyDeps = {}): Promise<StrategyResult<BrandStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  return change(ctx, deps, (doc) => ({
    draft: mergeFound(doc.draft, input.found, at, by),
    finder: input.mode === "quick" ? { ...doc.finder, quickAt: doc.finder.quickAt ?? at } : { ...doc.finder, fullRuns: [at, ...doc.finder.fullRuns].slice(0, L.finderRuns) },
  }));
}

/**
 * A person accepts (into the brand map's identity: the caller adds it there first) or declines a
 * proposed isNot line. Refused when the record changed (409) or there is no such proposal (404).
 */
export async function decideIsNot(ctx: TenantContext, input: { baseRev: number; text: string; accept: boolean }, deps: StrategyDeps = {}): Promise<StrategyResult<BrandStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  return change(ctx, deps, (doc, created) => {
    if (created) throw new Refused(404, "no_proposal");
    if (doc.rev !== input.baseRev) throw new Refused(409, "strategy_changed", doc);
    const draft = doc.draft;
    const at0 = draft?.isNotProposals.findIndex((x) => fold(x.text) === fold(input.text)) ?? -1;
    if (!draft || at0 < 0) throw new Refused(404, "no_proposal");
    const isNotProposals = draft.isNotProposals.map((x, i) => (i === at0 ? { ...x, state: input.accept ? ("accepted" as const) : ("declined" as const) } : x));
    return {
      draft: { ...draft, isNotProposals, at, by },
      decisions: withDecisions(doc.decisions, [decision(input.accept ? "is_not_accepted" : "is_not_declined", draft.isNotProposals[at0]!.text, at, by)]),
    };
  });
}

/** What approving decided: each proposed star kept or removed, each competitor found but left out. Pure. */
export function approveDecisions(draft: Strategy, at: string, by: string | null): StrategyDecision[] {
  const out: StrategyDecision[] = [decision("approved", "strategy", at, by)];
  const focus = new Set(draft.focusSituationIds);
  for (const id of draft.proposedFocusIds) out.push(decision(focus.has(id) ? "star_kept" : "star_removed", id, at, by));
  for (const c of competitorsOf(draft)) if (c.from === "finder" && !c.ticked) out.push(decision("competitor_left_out", c.name, at, by));
  return out;
}

/**
 * Approve the draft: it becomes what everything reads, the one before goes into history (5 kept),
 * and the brand map's buying situations are starred to match its focus (others unstarred).
 * Refused when the record changed since the person opened it (409 `strategy_changed`) or there is
 * no draft (409 `no_draft`).
 */
export async function approveStrategy(ctx: TenantContext, input: { baseRev: number }, deps: StrategyDeps = {}): Promise<StrategyResult<BrandStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  const done = await change(ctx, deps, (doc, created) => {
    if (created || !doc.draft) throw new Refused(409, "no_draft");
    if (doc.rev !== input.baseRev) throw new Refused(409, "strategy_changed", doc);
    const approved = StrategySchema.parse({ ...doc.draft, at, by });
    return {
      approved,
      draft: approved,
      history: [...(doc.approved ? [doc.approved] : []), ...doc.history].slice(0, L.history),
      decisions: withDecisions(doc.decisions, approveDecisions(doc.draft, at, by)),
    };
  });
  if (done.ok && done.value.approved) await setFocusFlags(ctx, done.value.approved.focusSituationIds, deps).catch(() => 0);
  return done;
}

/**
 * Star the brand map's decided buying situations to match the approved focus, and unstar the rest.
 * Each change moves the situation's revision, so a person with it open is told. Returns how many
 * changed.
 */
export async function setFocusFlags(ctx: TenantContext, ids: string[], deps: StrategyDeps = {}): Promise<number> {
  const store = brandMapRecords(ctx, deps.db);
  const want = new Set(ids);
  const at = nowIso(deps);
  let changed = 0;
  for (const row of await store.pageAll("sit")) {
    if (row.status !== "decided") continue;
    const focus = want.has(row.id);
    if (Boolean(row.focus) === focus) continue;
    const saved = await store.claim("sit", row.id, (cur) => (Boolean(cur.focus) === focus ? null : { focus, rev: Number(cur.rev ?? 0) + 1, updatedAt: at })).catch(() => null);
    if (saved) changed += 1;
  }
  return changed;
}

/** Remove the brand's strategy and everything kept with it (Start over, and the brand's erase path). */
export async function deleteBrandStrategy(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  const repo = repoOf(ctx, deps);
  const id = brandStrategyDocId(ctx.tenantId);
  if (!(await repo.getById(id))) return false;
  await repo.delete(id);
  return true;
}
