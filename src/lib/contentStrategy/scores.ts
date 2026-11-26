import { CONTENT_STAGES, type ContentSlot, type ContentStage, type Funnel, type SlotScores } from "@/lib/types/contentStrategy";

/**
 * Each slot's score, worked out in code, every part kept so the reason can be shown. Each part is
 * 0 to 100:
 *  - fit: the share of its questions on the approved brand strategy's focus situations;
 *  - demand: Search Console impressions for its questions against the brand's busiest slot (on a
 *    log scale), or, with none, how many People also ask questions Google showed for it;
 *  - gap: competitors wrote on it in the last 90 days and nothing live of the brand's answers it;
 *  - depth: it fills a pillar the brand has already started (the pillar's share of live slots);
 *  - balance: its stage is short against the funnel mix, among the slots already live.
 * The total weighs fit most, then demand, gap, balance and depth. Pure and client safe.
 */

export const SCORE_WEIGHTS = { fit: 0.3, demand: 0.25, gap: 0.2, balance: 0.15, depth: 0.1 } as const;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

type Scored = Pick<ContentSlot, "id" | "questionIds" | "stage" | "pillarId" | "coveredBy" | "facts">;

/** The stage mix of the slots already live, as percentages. Pure. */
export function liveMix(slots: ReadonlyArray<Pick<ContentSlot, "stage" | "coveredBy">>): Record<ContentStage, number> {
  const live = slots.filter((s) => s.coveredBy.length);
  const out = { learn: 0, consider: 0, choose: 0 } as Record<ContentStage, number>;
  for (const s of CONTENT_STAGES) out[s] = live.length ? (100 * live.filter((x) => x.stage === s).length) / live.length : 0;
  return out;
}

/** Every slot's scores. Pure. */
export function scoreSlots(slots: ReadonlyArray<Scored>, funnel: Funnel): Map<string, SlotScores> {
  const maxImpressions = Math.max(0, ...slots.map((s) => s.facts.impressions ?? 0));
  const mix = liveMix(slots);
  const pillar = new Map<string, { all: number; live: number }>();
  for (const s of slots) {
    if (!s.pillarId) continue;
    const p = pillar.get(s.pillarId) ?? { all: 0, live: 0 };
    p.all += 1;
    if (s.coveredBy.length) p.live += 1;
    pillar.set(s.pillarId, p);
  }
  const out = new Map<string, SlotScores>();
  for (const s of slots) {
    const covered = s.coveredBy.length > 0;
    const fit = clamp((100 * s.facts.focus) / Math.max(1, s.questionIds.length));
    const fromSearch = maxImpressions > 0 && (s.facts.impressions ?? 0) > 0 ? (100 * Math.log1p(s.facts.impressions ?? 0)) / Math.log1p(maxImpressions) : 0;
    const fromGoogle = s.facts.paa !== null ? s.facts.paa * 15 : 0;
    const demand = clamp(Math.max(fromSearch, fromGoogle));
    const gap = covered || !s.facts.theirs ? 0 : clamp(40 + 15 * s.facts.theirs);
    const p = s.pillarId ? pillar.get(s.pillarId) : undefined;
    const depth = covered || !p?.all ? 0 : clamp((100 * p.live) / p.all);
    const balance = clamp(50 + (funnel[s.stage] - mix[s.stage]));
    const total = clamp(SCORE_WEIGHTS.fit * fit + SCORE_WEIGHTS.demand * demand + SCORE_WEIGHTS.gap * gap + SCORE_WEIGHTS.depth * depth + SCORE_WEIGHTS.balance * balance);
    out.set(s.id, { fit, demand, gap, depth, balance, total });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a slot scores as it does, in plain words, from its kept parts: each reason only when its
 * part counts. `pillar` is its pillar's name and live slots. Pure and client safe.
 */
export function slotWhy(s: Pick<ContentSlot, "questionIds" | "coveredBy" | "kind" | "stage" | "scores" | "facts" | "hub">, pillar: { name: string; live: number } | null, funnel?: Funnel): string[] {
  const out: string[] = [];
  if (s.kind === "combine") out.push(`${plural(s.coveredBy.length, "live article")} answer it: keep one and fold the other in`);
  if (s.kind === "refresh") out.push("your live article on it can take its other questions, or is due a refresh");
  if (s.hub && pillar) out.push(`the hub of ${pillar.name}, written first`);
  if (s.facts.focus) out.push(`${s.facts.focus} of its ${plural(s.questionIds.length, "question")} sit on your focus situations`);
  if (s.facts.impressions) out.push(`${s.facts.impressions.toLocaleString("en")} Search Console impressions`);
  else if (s.facts.paa) out.push(`Google shows ${plural(s.facts.paa, "People also ask question")} for it`);
  if (s.scores.gap && s.facts.theirs) out.push(`competitors wrote ${plural(s.facts.theirs, "article")} on it in 90 days, and nothing live of yours answers it`);
  if (s.scores.depth && pillar) out.push(`it fills ${pillar.name}, which has ${pillar.live} live`);
  if (funnel && s.scores.balance > 60) out.push(`you have fewer ${s.stage} articles than your funnel mix asks for`);
  if (s.facts.serp === "same") out.push("Google shows the same results for its questions");
  return out;
}
