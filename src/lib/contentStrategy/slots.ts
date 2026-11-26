import { questionKey } from "@/lib/brandMap/keys";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { CLOSE_SIM } from "@/lib/nextUp/repeats";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { BlogIntent } from "@/lib/types/contentPlan";
import { CONTENT_STRATEGY_LIMITS as L, type ContentSlot, type ContentStage, type PageKind } from "@/lib/types/contentStrategy";
import { newSlotId } from "./store";

/**
 * Slots: the brand map's decided questions merged into the articles they belong in (decision 4:
 * one article per slot). Pure, apart from new ids.
 *
 *  - Grouped by meaning: each question is embedded the way Next up's stop repeats embeds them
 *    (QUESTION_TITLE), then grouped greedily, closest pairs first, at CLOSE (0.88). A join holds
 *    only when every question in the two groups is that close to every other, so a chain of
 *    rewordings never drags in a different ask. With no embedding, only the same words group.
 *  - Google's check (serp.ts) then splits a top question that shares fewer than 3 of the top 10
 *    results with its slot's first question.
 *  - Each slot has a stage (from its questions' intents), a kind of page (from its words and
 *    what is live), and the live articles that answer it (coverage, and the answeredBy links Next
 *    up keeps).
 */

/** The question closeness at which two questions are one article: Next up's CLOSE, which never moves. */
export const SLOT_SIM = CLOSE_SIM;

/** definition and how_to are learn; comparison and alternatives consider; pricing choose. The rest by what the buyer is doing. */
export const INTENT_STAGE: Record<BlogIntent, ContentStage> = {
  definition: "learn",
  how_to: "learn",
  other: "learn",
  comparison: "consider",
  alternatives: "consider",
  use_cases: "consider",
  limits: "consider",
  benchmarks: "consider",
  pricing: "choose",
  integrations: "choose",
};

/** A decided question as slots read it. */
export interface SlotQuestion {
  id: string;
  text: string;
  intent: BlogIntent;
  subjectId: string;
  /** On a focus situation of the approved brand strategy. */
  focus: boolean;
  /** Search Console impressions for it, when known. */
  impressions: number | null;
  /** open, planned, drafted or answered, from coverage. */
  state: "open" | "planned" | "drafted" | "answered";
  /** The live articles that answer it (page ids), furthest along first. */
  live: string[];
}

/** A slot before its pillar and scores. */
export type MadeSlot = Omit<ContentSlot, "pillarId" | "scores" | "hub">;

function unit(v: readonly number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n) || 1;
  return v.map((x) => x / len);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) s += a[i]! * b[i]!;
  return s;
}

/**
 * Group items by meaning. `vectors` in the items' order, or null to group by the same words only
 * (`keys`). Greedy and closest first: a join holds only when every pair across the two groups is at
 * least `close`, and no group passes `max`. Returns each group's item indexes, in item order,
 * groups in the order of their first item. Pure.
 */
export function groupByMeaning(keys: readonly string[], vectors: ReadonlyArray<readonly number[] | null> | null, opts: { close?: number; max?: number } = {}): number[][] {
  const close = opts.close ?? SLOT_SIM;
  const max = opts.max ?? L.questionsPerSlot;
  const n = keys.length;
  const group = Array.from({ length: n }, (_, i) => i);
  const members = new Map<number, number[]>(Array.from({ length: n }, (_, i) => [i, [i]] as const));
  const join = (a: number, b: number) => {
    const [keep, drop] = a < b ? [a, b] : [b, a];
    const merged = [...members.get(keep)!, ...members.get(drop)!].sort((x, y) => x - y);
    members.set(keep, merged);
    members.delete(drop);
    for (const i of merged) group[i] = keep;
  };

  // The same words are always one question.
  const byKey = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const k = keys[i]!;
    if (!k) continue;
    const first = byKey.get(k);
    if (first === undefined) byKey.set(k, i);
    else if (members.get(group[first]!)!.length + members.get(group[i]!)!.length <= max) join(group[first]!, group[i]!);
  }

  const ok = Boolean(vectors && vectors.length === n && vectors.every((v) => v && v.length));
  if (ok) {
    const v = (vectors as number[][]).map(unit);
    const sims = new Map<number, number>();
    const pairs: Array<{ i: number; j: number; s: number }> = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const s = dot(v[i]!, v[j]!);
        if (s < close) continue;
        sims.set(i * n + j, s);
        pairs.push({ i, j, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
    const sim = (a: number, b: number) => (a === b ? 1 : (sims.get(Math.min(a, b) * n + Math.max(a, b)) ?? 0));
    for (const { i, j } of pairs) {
      const gi = group[i]!;
      const gj = group[j]!;
      if (gi === gj) continue;
      const a = members.get(gi)!;
      const b = members.get(gj)!;
      if (a.length + b.length > max) continue;
      if (a.every((x) => b.every((y) => sim(x, y) >= close || keys[x] === keys[y]))) join(gi, gj);
    }
  }
  return [...members.values()].sort((a, b) => a[0]! - b[0]!);
}

/** A slot's stage: most of its questions', or its first question's when they tie. Pure. */
export function stageOf(intents: readonly BlogIntent[]): ContentStage {
  const count = { learn: 0, consider: 0, choose: 0 } as Record<ContentStage, number>;
  for (const i of intents) count[INTENT_STAGE[i] ?? "learn"] += 1;
  const first = INTENT_STAGE[intents[0] ?? "other"] ?? "learn";
  const top = Math.max(count.learn, count.consider, count.choose);
  return count[first] === top ? first : (["learn", "consider", "choose"] as const).find((s) => count[s] === top)!;
}

const TOOL = /\b(checker|validator|generator|calculator|template|tester|grader|analy[sz]er|free tool)s?\b/i;
const VIDEO = /\b(videos?|youtube|webinars?)\b/i;
const NEWS = /\b(news|announced|announcements?|latest updates?|what's new|what is new)\b/i;
const LIST = /\b(best|top \d+|top)\b/i;
const MANY = /\b(tools|apps|platforms|software|options|services|providers|agencies)\b/i;
const VERSUS = /(\bvs\.?\s|\bversus\b|\bcompared?\b|\bdifference between\b|\bor\b.+\bwhich\b)/i;

/**
 * The kind of page a slot needs. Two live articles answer it: combine them. One does, and it is
 * due a refresh or the slot has questions it doesn't answer yet: refresh it. Otherwise from its
 * words and intents: a tool page, a video, news, a list ("best X"), a comparison, or a guide. Pure.
 */
export function kindOf(input: { texts: readonly string[]; intents: readonly BlogIntent[]; live: number; due: boolean; open: number }): PageKind {
  if (input.live >= 2) return "combine";
  if (input.live === 1 && (input.due || input.open > 0)) return "refresh";
  const words = input.texts.join(" \n ");
  if (TOOL.test(words)) return "tool";
  if (VIDEO.test(words)) return "video";
  if (NEWS.test(words)) return "news";
  if (LIST.test(words) || (input.intents.includes("alternatives") && MANY.test(words))) return "list";
  if (input.intents.includes("comparison") || VERSUS.test(words)) return "comparison";
  return "guide";
}

/** Map subjects as coverage reads them. */
export interface CoverageSubject {
  id: string;
  name: string;
  home?: string | null;
  questions: Array<{ id: string; text: string; intent: BlogIntent; answeredBy?: { pageId: string } | null; notAnsweredBy?: readonly string[] }>;
}

/**
 * Each decided question's state and the live ARTICLES that answer it: by its id or words, or by the
 * live article Next up linked to it by meaning (answeredBy). Pure, from the brand's article rows.
 */
export function questionCoverage(subjects: CoverageSubject[], rows: BrandMapPage[]): Map<string, { state: SlotQuestion["state"]; live: string[] }> {
  const cov = computeCoverage({ subjects }, rows.filter((r) => r.kind === "article"));
  const out = new Map<string, { state: SlotQuestion["state"]; live: string[] }>();
  for (const s of cov.subjects) {
    for (const q of s.questions) {
      const live = q.pages.filter((p) => p.state === "live" && p.kind === "article").map((p) => p.id);
      const prior = out.get(q.id);
      // A question on two subjects (a merge in progress) keeps what either says.
      if (!prior || live.length > prior.live.length) out.set(q.id, { state: q.state, live });
    }
  }
  return out;
}

/** The live article pages of an approved slot that are due a refresh, by their plan ids. */
export const pageIdOfPlan = (planId: string) => `p_${planId}`;

/** Order a slot's questions: focus questions first, then the most searched, then map order. Pure. */
function ordered(qs: ReadonlyArray<{ q: SlotQuestion; i: number }>): SlotQuestion[] {
  return [...qs].sort((a, b) => Number(b.q.focus) - Number(a.q.focus) || (b.q.impressions ?? 0) - (a.q.impressions ?? 0) || a.i - b.i).map((x) => x.q);
}

/** One slot from its questions, the first one first. Pure, apart from its new id. */
export function slotFrom(qs: SlotQuestion[], due: ReadonlySet<string> = new Set()): MadeSlot {
  const liveCount = new Map<string, number>();
  for (const q of qs) for (const p of q.live) liveCount.set(p, (liveCount.get(p) ?? 0) + 1);
  const coveredBy = [...liveCount.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, L.coveredBy);
  const open = qs.filter((q) => q.state === "open").length;
  const impressions = qs.some((q) => q.impressions !== null) ? qs.reduce((n, q) => n + (q.impressions ?? 0), 0) : null;
  return {
    id: newSlotId(),
    title: qs[0]!.text.slice(0, L.slotTitle),
    questionIds: qs.map((q) => q.id),
    subjectIds: [...new Set(qs.map((q) => q.subjectId))].slice(0, L.questionsPerSlot),
    stage: stageOf(qs.map((q) => q.intent)),
    kind: kindOf({ texts: qs.map((q) => q.text), intents: qs.map((q) => q.intent), live: coveredBy.length, due: coveredBy.some((p) => due.has(p)), open }),
    coveredBy,
    inProgress: !coveredBy.length && qs.some((q) => q.state === "planned" || q.state === "drafted"),
    facts: { focus: qs.filter((q) => q.focus).length, impressions, paa: null, theirs: 0, serp: null },
    from: "plan",
  };
}

/**
 * The slots, from the decided questions in map order and their vectors (null: by words only). At
 * most 400: the ones with most focus questions, then the biggest, then those with live articles
 * are kept; `leftOut` says how many weren't. Pure, apart from new ids.
 */
export function makeSlots(
  questions: SlotQuestion[],
  vectors: ReadonlyArray<readonly number[] | null> | null,
  opts: { duePageIds?: ReadonlySet<string>; max?: number } = {},
): { slots: MadeSlot[]; leftOut: number } {
  const groups = groupByMeaning(
    questions.map((q) => questionKey(q.text)),
    vectors,
  );
  const due = opts.duePageIds ?? new Set<string>();
  const made = groups.map((idx, order) => ({ slot: slotFrom(ordered(idx.map((i) => ({ q: questions[i]!, i }))), due), order }));
  const max = opts.max ?? L.slots;
  const kept = [...made]
    .sort((a, b) => b.slot.facts.focus - a.slot.facts.focus || b.slot.questionIds.length - a.slot.questionIds.length || b.slot.coveredBy.length - a.slot.coveredBy.length || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((x) => x.slot);
  return { slots: kept, leftOut: Math.max(0, made.length - kept.length) };
}

/** Google's top 10 results for a question, as normalised addresses. */
export const topUrls = (top: ReadonlyArray<{ url: string }> | undefined) => [...new Set((top ?? []).slice(0, 10).map((r) => normalizeUrl(r.url) || r.url))];

/** 3 or more shared top 10 results means one article. */
export const SERP_SAME = 3;

/** How many results two questions' top 10s share. Pure. */
export function sharedResults(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  return b.filter((u) => set.has(u)).length;
}

/**
 * Google's check of each slot's top questions (its first three): one that shares fewer than 3 of
 * the top 10 results with the slot's first question goes into a slot of its own; one that shares 3
 * or more confirms the slot. A question with no lookup is left as meaning grouped it. Pure, apart
 * from new ids.
 */
export function splitBySerp(
  slots: MadeSlot[],
  tops: (questionId: string) => readonly string[] | null,
  byId: ReadonlyMap<string, SlotQuestion>,
  due: ReadonlySet<string> = new Set(),
): MadeSlot[] {
  const out: MadeSlot[] = [];
  for (const slot of slots) {
    const leadTop = slot.questionIds.length > 1 ? tops(slot.questionIds[0]!) : null;
    if (!leadTop?.length) {
      out.push(slot);
      continue;
    }
    const apart: string[] = [];
    let same = false;
    for (const q of slot.questionIds.slice(1, 3)) {
      const t = tops(q);
      if (!t?.length) continue;
      if (sharedResults(leadTop, t) >= SERP_SAME) same = true;
      else apart.push(q);
    }
    const qs = (ids: string[]) => ids.map((id) => byId.get(id)).filter((q): q is SlotQuestion => Boolean(q));
    if (!apart.length) {
      out.push(same ? { ...slot, facts: { ...slot.facts, serp: "same" } } : slot);
      continue;
    }
    const kept = slotFrom(qs(slot.questionIds.filter((q) => !apart.includes(q))), due);
    out.push({ ...kept, id: slot.id, title: slot.title, facts: { ...kept.facts, serp: same ? "same" : "split" } });
    for (const q of qs(apart)) {
      const own = slotFrom([q], due);
      out.push({ ...own, facts: { ...own.facts, serp: "split" } });
    }
  }
  return out.slice(0, L.slots);
}
