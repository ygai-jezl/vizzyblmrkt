import type { Candidate } from "@/lib/nextUp/candidates";
import { CLOSE_SIM } from "@/lib/nextUp/repeats";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { CloseTo, RepeatPair } from "@/lib/types/autopilot";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { NOT_ARTICLE_KINDS, type ContentPlan, type ContentSlot, type PickSlot, type RoadmapEntry } from "@/lib/types/contentStrategy";
import { isContentStrategyNextUpEnabled } from "./flags";
import { questionsNow, questionTexts, type QuestionDeps } from "./questions";
import { combineId, isSlotSkipped } from "./roadmap";
import { readContentStrategy } from "./store";

/**
 * Next up and the approved content plan (CONTENT_STRATEGY_NEXT_UP_ENABLED). The roadmap's next
 * open entries become candidates, each carrying its slot: a write is the slot's first open
 * question; a refresh is the freshness watch's candidate for its live article, or its first open
 * question offered as an addition to that article; a combine is the slot's two live articles,
 * for a person to keep one. They are mixed 3 to every 1 free candidate from today's ordering
 * (decision 5), and at most one of Next up's three picks is free.
 */

/** Roadmap entries read for one pick, in order. */
const ENTRIES_READ = 24;
/** Roadmap candidates offered at most. */
export const MAX_ROADMAP = 12;

export interface RoadmapDeps extends QuestionDeps {
  db?: FirestoreLike;
}

/** The approved plan Next up reads, or null with its switch off or none approved. */
export async function planForNextUp(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<ContentPlan | null> {
  if (!isContentStrategyNextUpEnabled()) return null;
  return readContentStrategy(ctx, deps).catch(() => null);
}

/** What a pick says of its slot. Pure. */
export function pickSlotOf(plan: ContentPlan, slot: ContentSlot, entry: RoadmapEntry): PickSlot {
  return { id: slot.id, title: slot.title, pillar: plan.pillars.find((p) => p.id === slot.pillarId)?.name ?? null, kind: slot.kind, stage: slot.stage, action: entry.action, week: entry.week };
}

async function pageRows(ctx: TenantContext, ids: string[], deps: RoadmapDeps): Promise<Map<string, BrandMapPage>> {
  const repo = forTenant(ctx, deps.db).brandMapPages;
  const out = new Map<string, BrandMapPage>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const raw = await repo.getById(id).catch(() => null);
      const parsed = raw ? BrandMapPageSchema.safeParse(raw) : null;
      if (parsed?.success) out.set(id, parsed.data);
    }),
  );
  return out;
}

const titleOf = (p: BrandMapPage) => (p.title || p.primaryQuestion || p.url || "Untitled").slice(0, 200);

/**
 * The question ids of every slot a person skipped a pick of lately, or that an active run holds
 * (`exclude`): skipping a pick skips its slot, so neither the roadmap nor the free list offers the
 * slot again through another of its questions. Pure.
 */
export function skippedSlotQuestions(plan: Pick<ContentPlan, "slots">, exclude: ReadonlySet<string>): Set<string> {
  return new Set(plan.slots.filter((s) => isSlotSkipped(s, exclude)).flatMap((s) => s.questionIds));
}

/**
 * The roadmap's next open entries as candidates, in roadmap order, each with its slot. An entry
 * whose slot is written, being written, no longer on the map, or had any of its picks skipped
 * lately (`exclude`: one of its questions, its combine or a refresh of its live article) is passed
 * over. `refreshes` are the freshness watch's candidates, matched by their live article.
 */
export async function roadmapCandidates(
  ctx: TenantContext,
  plan: ContentPlan,
  opts: { exclude: ReadonlySet<string>; refreshes: Candidate[]; max?: number },
  deps: RoadmapDeps = {},
): Promise<Candidate[]> {
  const max = opts.max ?? MAX_ROADMAP;
  const slots = new Map(plan.slots.map((s) => [s.id, s] as const));
  const entries = plan.roadmap.filter((e) => slots.has(e.slotId) && !NOT_ARTICLE_KINDS.has(slots.get(e.slotId)!.kind)).slice(0, ENTRIES_READ);
  const mine = entries.map((e) => slots.get(e.slotId)!);
  const [questions, pages] = await Promise.all([
    questionsNow(ctx, mine.flatMap((s) => s.questionIds), deps).catch(() => new Map()),
    pageRows(ctx, mine.flatMap((s) => s.coveredBy), deps),
  ]);
  const refreshOf = new Map<string, Candidate>(opts.refreshes.flatMap((c) => (c.refresh ? [[`p_${c.refresh.planId}`, c] as const] : [])));
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    if (seen.has(c.questionId) || opts.exclude.has(c.questionId)) return;
    seen.add(c.questionId);
    out.push(c);
  };
  for (const e of entries) {
    if (out.length >= max) break;
    const s = slots.get(e.slotId)!;
    // One article per slot: a skip of any of its picks, or a run holding one of its questions, holds the slot.
    if (isSlotSkipped(s, opts.exclude)) continue;
    const slot = pickSlotOf(plan, s, e);
    const firstOpen = s.questionIds.map((id) => questions.get(id)).find((q) => q && q.state === "open" && !opts.exclude.has(q.id));
    const asCandidate = (q: NonNullable<typeof firstOpen>, closeTo?: CloseTo): Candidate => ({
      questionId: q.id,
      question: q.text,
      subjectId: q.subjectId,
      subjectName: q.subjectName,
      answered: q.answered,
      total: q.total,
      lastArticleAt: null,
      focus: s.facts.focus > 0,
      slot,
      ...(closeTo ? { closeTo } : {}),
    });
    if (e.action === "combine") {
      const live = s.coveredBy.map((id) => pages.get(id)).filter((p): p is BrandMapPage => Boolean(p && p.state === "live"));
      if (live.length < 2) continue;
      const combinePages: RepeatPair["pages"] = live.map((p) => ({ title: titleOf(p), url: p.url, planId: p.planId, workspaceId: p.workspaceId }));
      add({ questionId: combineId(s), question: s.title, subjectId: s.subjectIds[0] ?? "", subjectName: "two live articles", answered: 0, total: 0, lastArticleAt: null, focus: false, slot, combine: { pages: combinePages } });
      continue;
    }
    if (e.action === "refresh") {
      const due = s.coveredBy.map((id) => refreshOf.get(id)).find(Boolean);
      if (due) {
        add({ ...due, slot });
        continue;
      }
      const page = s.coveredBy.map((id) => pages.get(id)).find((p) => p?.state === "live");
      if (firstOpen && page) {
        add(asCandidate(firstOpen, { planId: page.planId, workspaceId: page.workspaceId, title: titleOf(page), url: page.url, liveAt: page.liveAt, sim: CLOSE_SIM }));
        continue;
      }
    }
    if (firstOpen) add(asCandidate(firstOpen));
  }
  return out;
}

/** 3 of every 4 from the roadmap (`share`), the rest free, while both last; each candidate once. Pure. */
export function mixRoadmap(roadmap: Candidate[], free: Candidate[], share: number, max: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let r = 0;
  let f = 0;
  let fromRoadmap = 0;
  while (out.length < max && (r < roadmap.length || f < free.length)) {
    const wantRoadmap = fromRoadmap < Math.ceil(share * (out.length + 1) - 1e-9);
    const takeRoadmap = r < roadmap.length && (wantRoadmap || f >= free.length);
    const c = takeRoadmap ? roadmap[r++]! : free[f++]!;
    if (seen.has(c.questionId)) continue;
    seen.add(c.questionId);
    if (takeRoadmap) fromRoadmap += 1;
    out.push(c);
  }
  return out;
}

/** How many of Next up's picks may be free when the roadmap has candidates: 1 of 3 at 0.75. Pure. */
export const freePicksOf = (picks: number, share: number) => Math.max(0, picks - Math.round(picks * share));

/**
 * The other questions of the approved slot a question is in (CONTENT_STRATEGY_NEXT_UP_ENABLED),
 * so an article written for it is briefed with all of them. Empty with the switch off, no
 * approved plan, or a question in no slot.
 */
export async function slotQuestionsFor(ctx: TenantContext, questionId: string, deps: { db?: FirestoreLike } = {}): Promise<string[]> {
  const plan = await planForNextUp(ctx, deps);
  const slot = plan?.slots.find((s) => s.questionIds.includes(questionId));
  if (!slot || slot.questionIds.length < 2) return [];
  const others = slot.questionIds.filter((id) => id !== questionId);
  const texts = await questionTexts(ctx, others, deps).catch(() => new Map<string, string>());
  return others.flatMap((id) => (texts.has(id) ? [texts.get(id)!] : []));
}
