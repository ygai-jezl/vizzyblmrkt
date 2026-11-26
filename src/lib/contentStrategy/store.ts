import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import {
  CONTENT_STRATEGY_LIMITS as L,
  ContentPlanSchema,
  ContentStrategyDocSchema,
  contentStrategyDocId,
  type ContentPlan,
  type ContentSlot,
  type ContentStrategyDoc,
  type PlanDecision,
  type PlanDecisionKind,
  type PlanEdit,
  type PlanSummary,
  type PageKind,
} from "@/lib/types/contentStrategy";
import { isContentStrategyEnabled } from "./flags";
import { entryActionOf, weeksOf } from "./roadmap";
import { scoreSlots } from "./scores";
import { slotFrom, type SlotQuestion } from "./slots";

export type { ContentPlan, ContentSlot, ContentStrategyDoc, PlanDecision, PlanEdit } from "@/lib/types/contentStrategy";

/**
 * The content strategy's storage (CONTENT_STRATEGY_ENABLED): one document per brand,
 * `content_strategy/cst_<tenantId>`, in its region, through forTenant(ctx).
 *
 *  - MAKE THE PLAN replaces the draft with a new one (make.ts), and moves `rev`, so a person with
 *    an older copy open is told rather than overwriting it.
 *  - A person EDITS the draft one change at a time (split or join slots, rename a pillar, skip or
 *    move a roadmap entry), naming the revision they started from; an edit over someone else's is
 *    refused (409 `plan_changed`). Editing an approved plan with no draft starts a draft from it.
 *  - APPROVE makes the draft what Next up, the autopilot and Vizzy read; the draft clears until the
 *    plan is made again or edited, and the plan approved before goes into history, in short (5).
 *  - What people decided is kept in `decisions` (200 at most, newest first) for the learning
 *    loops. Only skipped picks are read back today, through the Learned list.
 */

export interface PlanStoreDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

export type PlanResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const repoOf = (ctx: TenantContext, deps: { db?: FirestoreLike }) => forTenant(ctx, deps.db).contentStrategy;
const nowIso = (deps: PlanStoreDeps) => (deps.now ?? (() => new Date()))().toISOString();
const byOf = (ctx: TenantContext) => ctx.email ?? ctx.userId ?? null;
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {
    super(error);
  }
}

export { newPillarId, newSlotId } from "./ids";

/** A stored document as the app reads it, or null when it no longer reads. */
export function parseContentStrategy(raw: Record<string, unknown> | null): ContentStrategyDoc | null {
  if (!raw) return null;
  const r = ContentStrategyDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The whole record (draft, approved, history, decisions), whatever the switch says. */
export async function readContentStrategyDoc(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<ContentStrategyDoc | null> {
  return parseContentStrategy(await repoOf(ctx, deps).getById(contentStrategyDocId(ctx.tenantId)));
}

/**
 * The brand's APPROVED content plan, the one Next up, the autopilot and Vizzy read. Null with
 * CONTENT_STRATEGY_ENABLED off, when none is approved yet, or when the record can't be read: the
 * reader then works exactly as before.
 */
export async function readContentStrategy(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<ContentPlan | null> {
  if (!isContentStrategyEnabled()) return null;
  const doc = await readContentStrategyDoc(ctx, deps).catch(() => null);
  return doc?.approved ?? null;
}

/** The size a document would be stored at, near enough. */
export function sizeOf(doc: unknown): number {
  return Buffer.byteLength(JSON.stringify(doc), "utf8");
}

/** Newest first, at most 200. Pure. */
export function withDecisions(existing: PlanDecision[], added: PlanDecision[]): PlanDecision[] {
  return [...added, ...existing].slice(0, L.decisions);
}

const decision = (kind: PlanDecisionKind, ref: string, at: string, by: string | null, before: string | null = null, after: string | null = null): PlanDecision => ({
  kind,
  ref: clip(ref, L.decisionText),
  before: before === null ? null : clip(before, L.decisionText),
  after: after === null ? null : clip(after, L.decisionText),
  at,
  by,
});

/** What history keeps of an approved plan: its pillars, rules and roadmap, each entry with its slot's first question. Pure. */
export function summaryOf(plan: ContentPlan): PlanSummary {
  const first = new Map(plan.slots.map((s) => [s.id, s.questionIds[0] ?? null] as const));
  return {
    at: plan.at,
    by: plan.by,
    made: plan.made,
    rules: plan.rules,
    pillars: plan.pillars.map((p) => ({ id: p.id, name: p.name })),
    roadmap: plan.roadmap.map((e) => ({ ...e, questionId: first.get(e.slotId) ?? null })),
    slots: plan.slots.length,
  };
}

function emptyDoc(tenantId: string, now: string) {
  return {
    rev: 0,
    draft: null as ContentPlan | null,
    approved: null as ContentPlan | null,
    history: [] as PlanSummary[],
    decisions: [] as PlanDecision[],
    createdAt: now,
    updatedAt: now,
    id: contentStrategyDocId(tenantId),
    tenantId,
  };
}

type Patch = Partial<Omit<ContentStrategyDoc, "id" | "tenantId" | "createdAt">>;
type Change = (doc: ContentStrategyDoc, created: boolean) => Patch | null;

/** Keep a document under the size limit: the oldest history goes first; past that it is refused. */
function fitted(doc: ContentStrategyDoc, patch: Patch): Patch {
  let next = { ...patch };
  let history = next.history ?? doc.history;
  while (sizeOf({ ...doc, ...next, history }) > L.bytes && history.length) history = history.slice(0, -1);
  if (sizeOf({ ...doc, ...next, history }) > L.bytes) throw new Refused(413, "plan_too_large");
  if (history !== (next.history ?? doc.history)) next = { ...next, history };
  return next;
}

/**
 * Change the record in one transaction: `plan` sees it as it is now (an empty one when there is
 * none) and returns what to change, null to change nothing, or throws Refused. Every change moves
 * `rev` and `updatedAt`.
 */
async function change(ctx: TenantContext, deps: PlanStoreDeps, plan: Change): Promise<PlanResult<ContentStrategyDoc>> {
  const now = nowIso(deps);
  const id = contentStrategyDocId(ctx.tenantId);
  try {
    const { doc } = await repoOf(ctx, deps).upsert(
      id,
      () => {
        const base = ContentStrategyDocSchema.parse(emptyDoc(ctx.tenantId, now));
        const patch = plan(base, true);
        // Nothing to make: refuse rather than create an empty record.
        if (!patch) throw new Refused(404, "no_plan");
        const { id: _i, tenantId: _t, ...rest } = { ...base, ...fitted(base, patch), rev: 1, updatedAt: now };
        void _i;
        void _t;
        return rest;
      },
      (current) => {
        const parsed = parseContentStrategy(current);
        if (!parsed) throw new Refused(409, "plan_unreadable");
        const patch = plan(parsed, false);
        if (!patch) return null;
        return { ...fitted(parsed, patch), rev: parsed.rev + 1, updatedAt: now };
      },
    );
    const parsed = parseContentStrategy(doc);
    return parsed ? { ok: true, value: parsed } : { ok: false, status: 409, error: "plan_unreadable" };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, status: err.status, error: err.error };
    throw err;
  }
}

/** Save a newly made plan as the draft (the record is made if there is none). What people decided stays. */
export async function saveMadePlan(ctx: TenantContext, plan: ContentPlan, deps: PlanStoreDeps = {}): Promise<PlanResult<ContentStrategyDoc>> {
  const at = nowIso(deps);
  const draft = ContentPlanSchema.parse({ ...plan, at, by: byOf(ctx) });
  return change(ctx, deps, () => ({ draft }));
}

/** What a split needs to know of the question it takes out: its words, for the new slot's title. */
export interface EditLookups {
  questionText: (questionId: string) => string | null;
  /** What is known of each question now (its coverage, focus and demand), for a split; read by the caller. */
  questions?: ReadonlyMap<string, SlotQuestion>;
  /** Live article pages due a refresh. */
  due?: ReadonlySet<string>;
}

/** A joined slot's kind, from the live articles that answer it now. Pure. */
export function kindAfterJoin(live: number, a: PageKind, b: PageKind): PageKind {
  if (live >= 2) return "combine";
  if (live === 1) return "refresh";
  const pick = [a, b].find((k) => k !== "combine" && k !== "refresh");
  return pick ?? "guide";
}

/**
 * After slots change: each named slot's roadmap entry takes the action its live articles need now
 * (a combine is never left as a write the autopilot would draft), or goes when there is nothing
 * left to do; and every slot is scored again, since scores weigh the whole plan. Changes `plan`.
 */
function settle(plan: ContentPlan, slotIds: string[]): void {
  const changed = new Set(slotIds);
  const byId = new Map(plan.slots.map((s) => [s.id, s] as const));
  plan.roadmap = plan.roadmap.flatMap((e) => {
    if (!changed.has(e.slotId)) return [e];
    const s = byId.get(e.slotId);
    const action = s ? entryActionOf(s) : null;
    return action ? [{ ...e, action }] : [];
  });
  const scores = scoreSlots(plan.slots, plan.rules.funnel);
  for (const s of plan.slots) s.scores = scores.get(s.id) ?? s.scores;
}

/** Order the roadmap by week, keeping the order within a week. Pure. */
const byWeek = (entries: ContentPlan["roadmap"]) => entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.week.localeCompare(b.e.week) || a.i - b.i).map((x) => x.e);

/**
 * Apply one person's change to a plan, and say what they decided. Pure. Refuses an edit naming a
 * slot, question, pillar or week the plan doesn't have (404 or 400), a split of a slot with one
 * question (409 `slot_single`), or a join that would hold too many questions (409 `slot_full`).
 */
export function applyPlanEdit(
  plan: ContentPlan,
  edit: PlanEdit,
  at: string,
  by: string | null,
  look: EditLookups,
): { ok: true; plan: ContentPlan; decisions: PlanDecision[] } | { ok: false; status: number; error: string } {
  const next: ContentPlan = structuredClone(plan);
  next.at = at;
  next.by = by;
  const slotOf = (id: string) => next.slots.find((s) => s.id === id);

  if (edit.op === "split") {
    const slot = slotOf(edit.slotId);
    if (!slot || !slot.questionIds.includes(edit.questionId)) return { ok: false, status: 404, error: "no_slot" };
    if (slot.questionIds.length < 2) return { ok: false, status: 409, error: "slot_single" };
    if (next.slots.length >= L.slots) return { ok: false, status: 409, error: "plan_full" };
    // Both slots are worked out again from their own questions: their coverage, focus and demand.
    const known = look.questions;
    const qOf = (id: string, kept: boolean): SlotQuestion =>
      known?.get(id) ?? {
        id,
        text: look.questionText(id) ?? slot.title,
        intent: "other",
        subjectId: slot.subjectIds[0] ?? "",
        focus: false,
        impressions: null,
        state: "open",
        // With nothing read about them, the questions that stay keep the slot's live articles.
        live: kept && !known ? slot.coveredBy : [],
      };
    const due = look.due ?? new Set<string>();
    const remaining = slot.questionIds.filter((q) => q !== edit.questionId);
    const wasFirst = slot.questionIds[0] === edit.questionId;
    const keptMade = slotFrom(remaining.map((id) => qOf(id, true)), due);
    const outMade = slotFrom([qOf(edit.questionId, false)], due);
    const kept: ContentSlot = {
      ...slot,
      ...keptMade,
      id: slot.id,
      title: wasFirst ? clip(look.questionText(remaining[0]!) ?? slot.title, L.slotTitle) || slot.title : slot.title,
      subjectIds: keptMade.subjectIds.length ? keptMade.subjectIds : slot.subjectIds,
      // What competitors write is counted by subject, and Google's check by the first question.
      facts: { ...keptMade.facts, theirs: slot.facts.theirs, paa: wasFirst ? null : slot.facts.paa, serp: slot.facts.serp },
      from: "person",
    };
    const out: ContentSlot = {
      ...outMade,
      title: clip(look.questionText(edit.questionId) ?? "", L.slotTitle) || outMade.title,
      subjectIds: outMade.subjectIds.length ? outMade.subjectIds : slot.subjectIds,
      facts: { ...outMade.facts, theirs: slot.facts.theirs, paa: wasFirst ? slot.facts.paa : null, serp: null },
      pillarId: slot.pillarId,
      hub: false,
      scores: slot.scores,
      from: "person",
    };
    next.slots.splice(next.slots.indexOf(slot), 1, kept, out);
    settle(next, [kept.id]);
    return { ok: true, plan: ContentPlanSchema.parse(next), decisions: [decision("slot_split", slot.id, at, by, edit.questionId, out.id)] };
  }

  if (edit.op === "join") {
    const into = slotOf(edit.intoSlotId);
    const from = slotOf(edit.slotId);
    if (!into || !from || into.id === from.id) return { ok: false, status: 404, error: "no_slot" };
    const questionIds = [...new Set([...into.questionIds, ...from.questionIds])];
    if (questionIds.length > L.questionsPerSlot) return { ok: false, status: 409, error: "slot_full" };
    into.questionIds = questionIds;
    into.subjectIds = [...new Set([...into.subjectIds, ...from.subjectIds])].slice(0, L.questionsPerSlot);
    into.coveredBy = [...new Set([...into.coveredBy, ...from.coveredBy])].slice(0, L.coveredBy);
    // What live articles answer it now decides its kind: two or more, combine; one, refresh.
    into.kind = kindAfterJoin(into.coveredBy.length, into.kind, from.kind);
    into.inProgress = !into.coveredBy.length && (into.inProgress || from.inProgress);
    into.hub = into.hub || from.hub;
    into.from = "person";
    into.facts.focus += from.facts.focus;
    into.facts.theirs = Math.max(into.facts.theirs, from.facts.theirs);
    if (from.facts.impressions !== null) into.facts.impressions = (into.facts.impressions ?? 0) + from.facts.impressions;
    next.slots = next.slots.filter((s) => s.id !== from.id);
    // One article per slot: the joined slot keeps the earlier of the two roadmap entries.
    let kept = false;
    next.roadmap = next.roadmap.flatMap((e) => {
      if (e.slotId !== into.id && e.slotId !== from.id) return [e];
      if (kept) return [];
      kept = true;
      return [{ ...e, slotId: into.id }];
    });
    for (const p of next.pillars) if (p.hub?.kind === "slot" && p.hub.slotId === from.id) p.hub = { kind: "slot", slotId: into.id };
    settle(next, [into.id]);
    return { ok: true, plan: ContentPlanSchema.parse(next), decisions: [decision("slot_joined", into.id, at, by, from.id, into.id)] };
  }

  if (edit.op === "rename_pillar") {
    const pillar = next.pillars.find((p) => p.id === edit.pillarId);
    if (!pillar) return { ok: false, status: 404, error: "no_pillar" };
    const name = clip(edit.name, L.pillarName);
    if (name === pillar.name) return { ok: true, plan, decisions: [] };
    const before = pillar.name;
    pillar.name = name;
    pillar.from = "person";
    return { ok: true, plan: ContentPlanSchema.parse(next), decisions: [decision("pillar_renamed", pillar.id, at, by, before, name)] };
  }

  const entry = next.roadmap.find((e) => e.slotId === edit.slotId);
  if (!entry) return { ok: false, status: 404, error: "no_pick" };
  if (edit.op === "skip") {
    next.roadmap = next.roadmap.filter((e) => e !== entry);
    return { ok: true, plan: ContentPlanSchema.parse(next), decisions: [decision("pick_skipped", entry.slotId, at, by, entry.week, edit.reason || null)] };
  }
  const weeks = new Set(weeksOf(next));
  if (!weeks.has(edit.week)) return { ok: false, status: 400, error: "unknown_week" };
  if (entry.week === edit.week) return { ok: true, plan, decisions: [] };
  const before = entry.week;
  entry.week = edit.week;
  next.roadmap = byWeek(next.roadmap);
  return { ok: true, plan: ContentPlanSchema.parse(next), decisions: [decision("pick_moved", entry.slotId, at, by, before, edit.week)] };
}

/**
 * Save a person's change to the draft (or to the approved plan, which starts a draft). Refused when
 * the record changed since they opened it (409 `plan_changed`) or there is no plan (409 `no_plan`).
 */
export async function savePlanEdit(ctx: TenantContext, edit: PlanEdit, look: EditLookups, deps: PlanStoreDeps = {}): Promise<PlanResult<ContentStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  return change(ctx, deps, (doc, created) => {
    const base = doc.draft ?? doc.approved;
    if (created || !base) throw new Refused(409, "no_plan");
    if (doc.rev !== edit.baseRev) throw new Refused(409, "plan_changed");
    const done = applyPlanEdit(base, edit, at, by, look);
    if (!done.ok) throw new Refused(done.status, done.error);
    if (!done.decisions.length) return null;
    return { draft: done.plan, decisions: withDecisions(doc.decisions, done.decisions) };
  });
}

/**
 * Approve the draft: it becomes what Next up, the autopilot and Vizzy read, the one before goes
 * into history in short (5 kept), and the draft clears. Refused when the record changed since the
 * person opened it (409 `plan_changed`) or there is no draft (409 `no_draft`).
 */
export async function approvePlan(ctx: TenantContext, input: { baseRev: number }, deps: PlanStoreDeps = {}): Promise<PlanResult<ContentStrategyDoc>> {
  const at = nowIso(deps);
  const by = byOf(ctx);
  return change(ctx, deps, (doc, created) => {
    if (created || !doc.draft) throw new Refused(409, "no_draft");
    if (doc.rev !== input.baseRev) throw new Refused(409, "plan_changed");
    const approved = ContentPlanSchema.parse({ ...doc.draft, at, by });
    const kept = decision("pick_kept", "roadmap", at, by, null, `${approved.roadmap.length} roadmap entries kept`);
    return {
      approved,
      draft: null,
      history: [...(doc.approved ? [summaryOf(doc.approved)] : []), ...doc.history].slice(0, L.history),
      decisions: withDecisions(doc.decisions, [decision("approved", "plan", at, by), kept]),
    };
  });
}

/** Remove the brand's content strategy and everything kept with it (Start over, and the brand's erase path). */
export async function deleteContentStrategy(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  const repo = repoOf(ctx, deps);
  const id = contentStrategyDocId(ctx.tenantId);
  if (!(await repo.getById(id))) return false;
  await repo.delete(id);
  return true;
}
