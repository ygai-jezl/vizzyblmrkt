import { NextResponse } from "next/server";
import { z } from "zod";
import { addLearned } from "@/lib/autopilot/learned";
import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isoWeekOf } from "@/lib/connectors/period";
import { forTenant, isRateLimited } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import {
  CONTENT_STAGES,
  NOT_ARTICLE_KINDS,
  PLAN_SOURCE_LABEL,
  PillarId,
  PlanEditSchema,
  type ContentPlan,
  type ContentStage,
  type ContentStrategyDoc,
  type PageKind,
  type RoadmapAction,
} from "@/lib/types/contentStrategy";
import { isContentStrategyEnabled, isContentStrategyNextUpEnabled } from "./flags";
import { makeContentPlan, type MakeDeps } from "./make";
import { questionTexts } from "./questions";
import { combineId, isOpenSlot } from "./roadmap";
import { slotWhy } from "./scores";
import { approvePlan, deleteContentStrategy, readContentStrategyDoc, savePlanEdit, type PlanResult } from "./store";

/**
 * The Content plan's APIs (Brand › Brand map › Strategy › Content plan): origin, switch, sign-in
 * and admin, in that order, as the brand map's. Members read it; admins make it, change it,
 * approve it and start over.
 */

export const planReader = (req: Request) => brandMapReader(req, { on: isContentStrategyEnabled, offError: "content_strategy_disabled" });
export const planAdmin = (req: Request) => brandMapAdmin(req, { on: isContentStrategyEnabled, offError: "content_strategy_disabled" });

/** Make the plan: embeddings, at most one model call and a few Google lookups, a few an hour per brand. */
export const MAKE_LIMIT = { prefix: "content_plan_make", burstLimit: 2, hourlyLimit: 6 };

const noStore = { "cache-control": "no-store" };
/** The weeks the section shows ahead. */
export const NEXT_WEEKS = 3;

export interface ViewDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

/** A live article as the section shows it. */
export interface ViewPage {
  title: string;
  url: string | null;
}

export interface ViewEntry {
  week: string;
  slotId: string;
  action: RoadmapAction;
  title: string;
  kind: PageKind;
  stage: ContentStage;
  pillar: string | null;
  why: string[];
  live: ViewPage[];
}

export interface ViewPillar {
  id: string;
  name: string;
  about: string;
  from: string;
  slots: number;
  live: number;
  open: number;
  hub: { kind: "home"; url: string } | { kind: "slot"; title: string; live: boolean } | null;
  focus: string[];
}

export interface ViewSlot {
  id: string;
  title: string;
  pillarId: string | null;
  kind: PageKind;
  stage: ContentStage;
  questions: number;
  live: number;
  hub: boolean;
  score: number;
  week: string | null;
}

export interface ContentPlanView {
  rev: number;
  /** none: no plan yet; draft: never approved; approved: what Next up reads; changed: a draft waits beside the approved one. */
  state: "none" | "draft" | "approved" | "changed";
  approved: { at: string; by: string | null } | null;
  /** Next up takes 3 of 4 picks from the approved plan here (CONTENT_STRATEGY_NEXT_UP_ENABLED). */
  feedsNextUp: boolean;
  madeAt: string | null;
  firstWeek: string | null;
  weeks: string[];
  pillars: ViewPillar[];
  next: ViewEntry[];
  slots: ViewSlot[];
  funnel: { target: Record<ContentStage, number>; questions: Record<ContentStage, number>; roadmap: Record<ContentStage, number> };
  notArticles: Array<{ title: string; kind: PageKind }>;
  counts: { slots: number; live: number; open: number; questions: number; leftOut: number; roadmap: number };
  sources: string[];
}

function stateOf(doc: ContentStrategyDoc | null): ContentPlanView["state"] {
  if (!doc || (!doc.draft && !doc.approved)) return "none";
  if (!doc.approved) return "draft";
  return doc.draft ? "changed" : "approved";
}

/** The plan's weeks, in order. Pure. */
export const weeksOf = (plan: ContentPlan) => [...new Set([...plan.blocks.flatMap((b) => b.weeks), ...plan.roadmap.map((e) => e.week)])].sort();

/** The roadmap's entries from this week on, for the next few weeks that have any. Pure. */
export function nextEntries(plan: ContentPlan, thisWeek: string, weeks = NEXT_WEEKS) {
  const ahead = plan.roadmap.filter((e) => e.week >= thisWeek);
  const shown = [...new Set(ahead.map((e) => e.week))].slice(0, weeks);
  return ahead.filter((e) => shown.includes(e.week));
}

/** A pillar's counts and hub, for the section and Vizzy. Pure. */
export function pillarSummary(plan: ContentPlan): Array<ViewPillar & { slotIds: string[] }> {
  return plan.pillars.map((p) => {
    const mine = plan.slots.filter((s) => s.pillarId === p.id);
    const hub = p.hub;
    const hubSlot = hub?.kind === "slot" ? plan.slots.find((s) => s.id === hub.slotId) : undefined;
    return {
      id: p.id,
      name: p.name,
      about: p.about,
      from: p.from,
      slots: mine.length,
      live: mine.filter((s) => s.coveredBy.length).length,
      open: mine.filter(isOpenSlot).length,
      hub: hub?.kind === "home" ? { kind: "home", url: hub.url } : hubSlot ? { kind: "slot", title: hubSlot.title, live: hubSlot.coveredBy.length > 0 } : null,
      focus: plan.blocks.filter((b) => b.pillarIds.includes(p.id)).map((b) => b.month),
      slotIds: mine.map((s) => s.id),
    };
  });
}

/** Percentages of a count by stage. Pure. */
export function mixOf(stages: readonly ContentStage[]): Record<ContentStage, number> {
  const n = Math.max(1, stages.length);
  return Object.fromEntries(CONTENT_STAGES.map((s) => [s, Math.round((100 * stages.filter((x) => x === s).length) / n)])) as Record<ContentStage, number>;
}

/** The live articles named by page id, with their titles (a few reads). */
async function livePages(ctx: TenantContext, ids: string[], deps: ViewDeps): Promise<Map<string, ViewPage>> {
  const repo = forTenant(ctx, deps.db).brandMapPages;
  const out = new Map<string, ViewPage>();
  await Promise.all(
    [...new Set(ids)].slice(0, 30).map(async (id) => {
      const row = await repo.getById(id).catch(() => null);
      if (row) out.set(id, { title: (row.title || row.primaryQuestion || row.url || "Untitled").slice(0, 160), url: row.url ?? null });
    }),
  );
  return out;
}

/** This week, as the roadmap names weeks. */
export const thisWeekOf = (now: Date) => isoWeekOf(now.toISOString().slice(0, 10));

/** Everything the Content plan section shows, for any member of the brand. */
export async function planView(ctx: TenantContext, deps: ViewDeps = {}): Promise<ContentPlanView> {
  const doc = await readContentStrategyDoc(ctx, deps).catch(() => null);
  const plan = doc?.draft ?? doc?.approved ?? null;
  const state = stateOf(doc);
  const base = { rev: doc?.rev ?? 0, state, approved: doc?.approved ? { at: doc.approved.at, by: doc.approved.by } : null, feedsNextUp: isContentStrategyNextUpEnabled() };
  if (!plan) {
    return {
      ...base,
      madeAt: null,
      firstWeek: null,
      weeks: [],
      pillars: [],
      next: [],
      slots: [],
      funnel: { target: { learn: 50, consider: 30, choose: 20 }, questions: { learn: 0, consider: 0, choose: 0 }, roadmap: { learn: 0, consider: 0, choose: 0 } },
      notArticles: [],
      counts: { slots: 0, live: 0, open: 0, questions: 0, leftOut: 0, roadmap: 0 },
      sources: [],
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  const pillars = pillarSummary(plan);
  const pillarName = new Map(plan.pillars.map((p) => [p.id, p.name] as const));
  const pillarLive = new Map(pillars.map((p) => [p.id, p.live] as const));
  const slotById = new Map(plan.slots.map((s) => [s.id, s] as const));
  const entries = nextEntries(plan, thisWeekOf(now));
  const pages = await livePages(ctx, entries.flatMap((e) => slotById.get(e.slotId)?.coveredBy ?? []), deps);
  const weekOf = new Map(plan.roadmap.map((e) => [e.slotId, e.week] as const));
  return {
    ...base,
    madeAt: plan.at,
    firstWeek: plan.blocks[0]?.weeks[0] ?? null,
    weeks: weeksOf(plan),
    pillars: pillars.map(({ slotIds: _ids, ...p }) => {
      void _ids;
      return p;
    }),
    next: entries.flatMap((e) => {
      const s = slotById.get(e.slotId);
      if (!s) return [];
      const pillar = s.pillarId ? { name: pillarName.get(s.pillarId) ?? "", live: pillarLive.get(s.pillarId) ?? 0 } : null;
      return [{ week: e.week, slotId: s.id, action: e.action, title: s.title, kind: s.kind, stage: s.stage, pillar: pillar?.name ?? null, why: slotWhy(s, pillar, plan.rules.funnel), live: s.coveredBy.flatMap((p) => (pages.has(p) ? [pages.get(p)!] : [])) }];
    }),
    slots: plan.slots.map((s) => ({ id: s.id, title: s.title, pillarId: s.pillarId, kind: s.kind, stage: s.stage, questions: s.questionIds.length, live: s.coveredBy.length, hub: s.hub, score: s.scores.total, week: weekOf.get(s.id) ?? null })),
    funnel: {
      target: plan.rules.funnel,
      questions: plan.stageMix,
      roadmap: mixOf(plan.roadmap.filter((e) => e.action === "write").flatMap((e) => (slotById.has(e.slotId) ? [slotById.get(e.slotId)!.stage] : []))),
    },
    notArticles: plan.slots.filter((s) => NOT_ARTICLE_KINDS.has(s.kind) && !s.coveredBy.length).slice(0, 12).map((s) => ({ title: s.title, kind: s.kind })),
    counts: {
      slots: plan.slots.length,
      live: plan.slots.filter((s) => s.coveredBy.length).length,
      open: plan.slots.filter(isOpenSlot).length,
      questions: plan.questions,
      leftOut: plan.leftOut,
      roadmap: plan.roadmap.length,
    },
    sources: plan.sources.map((s) => PLAN_SOURCE_LABEL[s]),
  };
}

/** One pillar's slots with their questions' words, for splitting and joining. */
export async function pillarSlots(ctx: TenantContext, pillarId: string | null, deps: ViewDeps = {}): Promise<Array<{ id: string; title: string; kind: PageKind; stage: ContentStage; live: number; questions: Array<{ id: string; text: string }> }>> {
  const doc = await readContentStrategyDoc(ctx, deps).catch(() => null);
  const plan = doc?.draft ?? doc?.approved ?? null;
  if (!plan) return [];
  const mine = plan.slots.filter((s) => s.pillarId === pillarId).slice(0, 120);
  const texts = await questionTexts(ctx, mine.flatMap((s) => s.questionIds), deps);
  return mine.map((s) => ({ id: s.id, title: s.title, kind: s.kind, stage: s.stage, live: s.coveredBy.length, questions: s.questionIds.map((id) => ({ id, text: texts.get(id) ?? "A question no longer on the map" })) }));
}

function fail(r: { status: number; error: string }): Response {
  return NextResponse.json({ error: r.error }, { status: r.status });
}

async function answer(ctx: TenantContext, r: PlanResult<unknown>, deps: ViewDeps, extra: Record<string, unknown> = {}): Promise<Response> {
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, ...extra, plan: await planView(ctx, deps) }, { headers: noStore });
}

const PillarQuery = z.union([PillarId, z.literal("none")]);

/** GET: the section, or with `pillar` one pillar's slots and their questions. */
export async function viewFromRequest(ctx: TenantContext, url: string, deps: ViewDeps = {}): Promise<Response> {
  const pillar = new URL(url).searchParams.get("pillar");
  if (pillar !== null) {
    const parsed = PillarQuery.safeParse(pillar);
    if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    return NextResponse.json({ slots: await pillarSlots(ctx, parsed.data === "none" ? null : parsed.data, deps) }, { headers: noStore });
  }
  return NextResponse.json({ plan: await planView(ctx, deps) }, { headers: noStore });
}

/**
 * PUT: one change to the draft. A skipped pick also goes on the Learned list, as a skip in Next
 * up does, so the next plan and Next up pass over it for 30 days.
 */
export async function editFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = PlanEditSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const edit = parsed.data;
  const doc = await readContentStrategyDoc(ctx, deps).catch(() => null);
  const plan = doc?.draft ?? doc?.approved ?? null;
  const slot = "slotId" in edit ? plan?.slots.find((s) => s.id === edit.slotId) : undefined;
  const texts = edit.op === "split" && slot ? await questionTexts(ctx, slot.questionIds, deps) : new Map<string, string>();
  const r = await savePlanEdit(ctx, edit, { questionText: (id) => texts.get(id) ?? null }, deps);
  if (r.ok && edit.op === "skip" && slot) {
    const entry = plan?.roadmap.find((e) => e.slotId === slot.id);
    const questionId = entry?.action === "combine" ? combineId(slot) : (slot.questionIds[0] ?? null);
    await addLearned(ctx, { kind: "skipped_pick", text: slot.title, reason: edit.reason, questionId, from: "person" }, deps).catch(() => null);
  }
  return answer(ctx, r, deps);
}

const ApproveBody = z.object({ baseRev: z.number().int().min(0) }).strict();

/** POST approve: the draft becomes what Next up, the autopilot and Vizzy read. */
export async function approveFromRequest(ctx: TenantContext, body: unknown, deps: ViewDeps = {}): Promise<Response> {
  const parsed = ApproveBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return answer(ctx, await approvePlan(ctx, parsed.data, deps), deps);
}

/** POST make: a new draft from the brand map and the approved strategy. Nothing approved changes. */
export async function makeFromRequest(ctx: TenantContext, deps: MakeDeps & ViewDeps = {}): Promise<Response> {
  const r = await makeContentPlan(ctx, deps);
  if (!r.ok) return fail(r);
  return NextResponse.json({ ok: true, notes: r.notes, plan: await planView(ctx, deps) }, { headers: noStore });
}

/** DELETE: start over. The plan, its history and its decisions go; the brand map and the strategy stay. */
export async function deleteFromRequest(ctx: TenantContext, deps: ViewDeps = {}): Promise<Response> {
  await deleteContentStrategy(ctx, deps);
  return NextResponse.json({ ok: true, plan: await planView(ctx, deps) }, { headers: noStore });
}

/** The brand's own limit for Make the plan. */
export async function overLimit(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  return isRateLimited(`tenant:${ctx.tenantId}`, MAKE_LIMIT, { db: deps.db });
}
