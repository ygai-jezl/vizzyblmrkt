import { isoWeekOf } from "@/lib/connectors/period";
import {
  CONTENT_STAGES,
  CONTENT_STRATEGY_LIMITS as L,
  NOT_ARTICLE_KINDS,
  type ContentPillar,
  type ContentSlot,
  type ContentStage,
  type FocusBlock,
  type Funnel,
  type RoadmapEntry,
} from "@/lib/types/contentStrategy";

/**
 * The 12 week roadmap, worked out in code. Pure and client safe.
 *
 *  - Three blocks of four weeks, each with one focus pillar (two when the plan has more than 3),
 *    the pillars taking turns, the strongest first (the sum of its best open slots' scores).
 *  - In each block the focus pillars' hubs come first, then their open slots, best score first,
 *    keeping the funnel mix: each write takes the stage furthest under its share so far.
 *  - `perWeek` entries a week: the autopilot's articles a week.
 *  - The refresh share of entries fix a live article: combines first (two live articles answer
 *    one slot, Next up's repeats first), then refreshes (articles the freshness watch says are
 *    due first, then live articles that don't answer all their slot's questions yet).
 *  - One entry per slot; never a tool page or a video (done by hand for now), never a slot an
 *    article is being written for, and never one a person skipped in the last 30 days.
 */

const DAY_MS = 86_400_000;

/** The ISO weeks from the one `now` falls in, with the Monday each starts on. Pure. */
export function weeksFrom(now: Date, count: number = L.weeks): Array<{ week: string; monday: string }> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = new Date(day.getTime() - ((day.getUTCDay() || 7) - 1) * DAY_MS);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(monday.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10);
    return { week: isoWeekOf(d), monday: d };
  });
}

export interface RoadmapInput {
  slots: ReadonlyArray<Pick<ContentSlot, "id" | "questionIds" | "stage" | "kind" | "pillarId" | "coveredBy" | "inProgress" | "hub" | "scores">>;
  pillars: ReadonlyArray<Pick<ContentPillar, "id" | "hub">>;
  weeks: ReadonlyArray<{ week: string; monday: string }>;
  perWeek: number;
  funnel: Funnel;
  /** The share of entries that refresh or combine a live article. */
  refreshShare: number;
  /** Live article pages due a refresh, most due first. */
  duePageIds?: readonly string[];
  /** Slots Next up found two live articles repeating. */
  repeatSlotIds?: ReadonlySet<string>;
  /** Question ids (or `combine:<question id>`) a person skipped lately. */
  skipped?: ReadonlySet<string>;
}

/** Whether a slot can be written as a new article. */
export const isOpenSlot = (s: Pick<ContentSlot, "coveredBy" | "inProgress" | "kind">) => !s.coveredBy.length && !s.inProgress && !NOT_ARTICLE_KINDS.has(s.kind);

/** The id Next up gives a combine pick: stable across plans, so a skip holds. */
export const combineId = (s: Pick<ContentSlot, "questionIds">) => `combine:${s.questionIds[0] ?? ""}`;

/** The funnel stage furthest under its share if one more is added, in funnel order on a tie. Pure. */
export function stagesByNeed(counts: Record<ContentStage, number>, funnel: Funnel): ContentStage[] {
  const n = CONTENT_STAGES.reduce((t, s) => t + counts[s], 0) + 1;
  return [...CONTENT_STAGES].sort((a, b) => (funnel[b] / 100) * n - counts[b] - ((funnel[a] / 100) * n - counts[a]) || CONTENT_STAGES.indexOf(a) - CONTENT_STAGES.indexOf(b));
}

/** The roadmap and its focus blocks. Pure. */
export function makeRoadmap(input: RoadmapInput): { roadmap: RoadmapEntry[]; blocks: FocusBlock[] } {
  const skipped = input.skipped ?? new Set<string>();
  const isSkipped = (s: Pick<ContentSlot, "questionIds">) => s.questionIds.some((q) => skipped.has(q));
  const byScore = <T extends { scores: { total: number } }>(list: T[]) => list.map((s, i) => ({ s, i })).sort((a, b) => b.s.scores.total - a.s.scores.total || a.i - b.i).map((x) => x.s);

  const open = byScore(input.slots.filter((s) => isOpenSlot(s) && !isSkipped(s)));
  // Pillars, strongest first: the sum of their best three open slots.
  const strength = (pid: string) =>
    open
      .filter((s) => s.pillarId === pid)
      .slice(0, 3)
      .reduce((t, s) => t + s.scores.total, 0);
  const ranked = input.pillars.map((p, i) => ({ p, i })).sort((a, b) => strength(b.p.id) - strength(a.p.id) || a.i - b.i).map((x) => x.p);
  const perBlock = ranked.length > 3 ? 2 : 1;
  const blocks: FocusBlock[] = [];
  for (let b = 0; b * 4 < input.weeks.length && b < 3; b += 1) {
    const weeks = input.weeks.slice(b * 4, b * 4 + 4);
    const pillarIds = ranked.length ? [...new Set(Array.from({ length: perBlock }, (_, k) => ranked[(b * perBlock + k) % ranked.length]!.id))] : [];
    blocks.push({ month: weeks[0]!.monday.slice(0, 7), weeks: weeks.map((w) => w.week), pillarIds });
  }

  // What fixes a live article: combines (repeats first), then refreshes (due first).
  const due = input.duePageIds ?? [];
  const dueRank = (s: Pick<ContentSlot, "coveredBy">) => {
    const k = Math.min(...s.coveredBy.map((p) => (due.includes(p) ? due.indexOf(p) : Number.POSITIVE_INFINITY)));
    return Number.isFinite(k) ? k : due.length + 1;
  };
  const combines = byScore(input.slots.filter((s) => s.kind === "combine" && !skipped.has(combineId(s)) && !isSkipped(s))).sort(
    (a, b) => Number(input.repeatSlotIds?.has(b.id) ?? false) - Number(input.repeatSlotIds?.has(a.id) ?? false),
  );
  const refreshes = byScore(input.slots.filter((s) => s.kind === "refresh" && !isSkipped(s))).sort((a, b) => dueRank(a) - dueRank(b));
  const fixes: Array<{ id: string; action: "combine" | "refresh" }> = [...combines.map((s) => ({ id: s.id, action: "combine" as const })), ...refreshes.map((s) => ({ id: s.id, action: "refresh" as const }))];

  const used = new Set<string>();
  const counts = { learn: 0, consider: 0, choose: 0 } as Record<ContentStage, number>;
  const hubOf = new Map(input.pillars.flatMap((p) => (p.hub?.kind === "slot" ? [[p.id, p.hub.slotId] as const] : [])));
  const roadmap: RoadmapEntry[] = [];
  const perWeek = Math.max(1, Math.min(10, Math.floor(input.perWeek)));
  const share = Math.max(0, Math.min(1, input.refreshShare));
  let fixed = 0;

  const nextWrite = (focus: readonly string[]) => {
    // The hub first.
    for (const pid of focus) {
      const hub = open.find((s) => s.id === hubOf.get(pid) && !used.has(s.id));
      if (hub) return hub;
    }
    const left = open.filter((s) => !used.has(s.id));
    for (const pool of [left.filter((s) => s.pillarId && focus.includes(s.pillarId)), left]) {
      for (const stage of stagesByNeed(counts, input.funnel)) {
        const pick = pool.find((s) => s.stage === stage);
        if (pick) return pick;
      }
    }
    return null;
  };

  for (const block of blocks) {
    for (const week of block.weeks) {
      for (let k = 0; k < perWeek && roadmap.length < L.roadmap; k += 1) {
        const i = roadmap.length;
        const fixDue = fixed < fixes.length && fixed < Math.ceil((i + 1) * share - 1e-9);
        const write = fixDue ? null : nextWrite(block.pillarIds);
        if (write) {
          used.add(write.id);
          counts[write.stage] += 1;
          roadmap.push({ week, slotId: write.id, action: "write" });
        } else if (fixed < fixes.length && (fixDue || share > 0)) {
          const f = fixes[fixed++]!;
          roadmap.push({ week, slotId: f.id, action: f.action });
        }
      }
    }
  }
  return { roadmap, blocks };
}
