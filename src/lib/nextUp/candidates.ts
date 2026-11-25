import { isBrandMapScaleEnabled, isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { listSubjects } from "@/lib/brandMap/records";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { listSituations, readSituation } from "@/lib/brandMap/situations";
import { readBrandMap } from "@/lib/brandMap/store";
import { computeCoverage, type QuestionCoverage } from "@/lib/content/blog/coverage";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { FreshnessReason } from "@/lib/types/contentPlan";
import type { CloseTo } from "@/lib/types/autopilot";
import { isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";

/**
 * Next up's candidates: the brand map's open questions worth weighing, narrowed in code so one
 * Gemini call can choose among them. Questions on a buying situation the brand focuses on come
 * first, then the least answered subjects, taking turns across subjects so one subject can't fill
 * the list. A question already planned, drafted or answered, in an active run, or skipped lately
 * is left out.
 */

export interface Candidate {
  questionId: string;
  question: string;
  subjectId: string;
  subjectName: string;
  /** How far along its subject is. */
  answered: number;
  total: number;
  /** When the subject last had an article go live. */
  lastArticleAt: string | null;
  /** On a buying situation the brand focuses on. */
  focus: boolean;
  /** A live article due a refresh (BLOG_FRESHNESS_ENABLED): its plan, programme and reasons. */
  refresh?: { planId: string; workspaceId: string; reasons: FreshnessReason[] };
  /** Stop repeats (NEXT_UP_REPEATS_ENABLED): a live article it is close to in meaning. */
  closeTo?: CloseTo;
}

export interface CandidateDeps {
  db?: FirestoreLike;
}

/** At most this many go to the model. */
export const MAX_CANDIDATES = 24;
/** Subjects read on a large map (each is one read of its rows). */
const MAX_SUBJECTS = 10;

const lastLive = (rows: BrandMapPage[], subjectId: string) =>
  rows
    .filter((r) => r.kind === "article" && r.subjectId === subjectId && r.liveAt)
    .map((r) => r.liveAt!)
    .sort()
    .at(-1) ?? null;

function fromCoverage(subject: { id: string; name: string }, questions: QuestionCoverage[], rows: BrandMapPage[]): Candidate[] {
  const answered = questions.filter((q) => q.state === "answered").length;
  const last = lastLive(rows, subject.id);
  return questions
    .filter((q) => q.state === "open")
    .map((q) => ({ questionId: q.id, question: q.text, subjectId: subject.id, subjectName: subject.name, answered, total: questions.length, lastArticleAt: last, focus: false }));
}

/**
 * How much a subject needs writing (NEXT_UP_REPEATS_ENABLED): its unanswered share, weighed by the
 * square root of its open questions, so a subject with one question no longer jumps the queue but a
 * small one still gets its turn. Most first.
 */
export function subjectNeed(answeredShare: number, open: number): number {
  return (1 - Math.min(1, Math.max(0, answeredShare))) * Math.sqrt(Math.max(0, open));
}

/** Take turns across subjects, so the list mixes them. */
function interleave(groups: Candidate[][], max: number): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; out.length < max && groups.some((g) => g.length > i); i += 1) {
    for (const g of groups) {
      if (g[i] && out.length < max) out.push(g[i]!);
    }
  }
  return out;
}

/** Open questions on the brand's focus situations (large maps only). */
async function focusIds(ctx: TenantContext, deps: CandidateDeps): Promise<Set<string>> {
  if (!isBrandMapSituationsEnabled()) return new Set();
  const focus = (await listSituations(ctx, { db: deps.db }).catch(() => [])).filter((s) => s.status === "decided" && s.focus);
  const ids = new Set<string>();
  for (const s of focus.slice(0, 5)) {
    const read = await readSituation(ctx, s.id, { db: deps.db }).catch(() => null);
    for (const q of read?.questions ?? []) if (q.status === "decided" && q.state === "open") ids.add(q.id);
  }
  return ids;
}

/**
 * The candidates, best first. `exclude` holds question ids not to offer (active runs, recent skips).
 */
export async function nextUpCandidates(ctx: TenantContext, opts: { exclude?: Set<string>; max?: number } = {}, deps: CandidateDeps = {}): Promise<Candidate[]> {
  const exclude = opts.exclude ?? new Set<string>();
  const max = opts.max ?? MAX_CANDIDATES;
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return [];
  const map = read.map;
  let groups: Candidate[][];

  if (isBrandMapScaleEnabled() && map.moved) {
    const subjects = (await listSubjects(ctx, { status: "decided" }, { db: deps.db }).catch(() => []))
      .filter((s) => s.counts.open > 0)
      .sort((a, b) =>
        isNextUpRepeatsEnabled()
          ? subjectNeed(b.answeredShare / 1000, b.counts.open) - subjectNeed(a.answeredShare / 1000, a.counts.open) || b.counts.open - a.counts.open
          : a.answeredShare - b.answeredShare || b.counts.open - a.counts.open,
      )
      .slice(0, MAX_SUBJECTS);
    const focus = await focusIds(ctx, deps);
    groups = [];
    for (const s of subjects) {
      const cov = await subjectCoverage(ctx, s.id, { db: deps.db }).catch(() => null);
      if (!cov) continue;
      groups.push(fromCoverage(cov.subject, cov.coverage.questions, cov.rows).map((c) => ({ ...c, focus: focus.has(c.questionId) })));
    }
  } else {
    const rows = await listBrandMapPages(ctx, deps.db).catch(() => [] as BrandMapPage[]);
    const cov = computeCoverage(map, rows);
    groups = cov.subjects
      .map((s) => fromCoverage(s, s.questions, rows))
      .filter((g) => g.length)
      .sort((a, b) =>
        isNextUpRepeatsEnabled()
          ? subjectNeed(b[0]!.answered / b[0]!.total, b.length) - subjectNeed(a[0]!.answered / a[0]!.total, a.length)
          : a[0]!.answered / a[0]!.total - b[0]!.answered / b[0]!.total,
      );
  }

  const kept = groups.map((g) => g.filter((c) => !exclude.has(c.questionId))).filter((g) => g.length);
  // Focus questions first, then turns across the least answered subjects.
  const focused = kept.flat().filter((c) => c.focus);
  const rest = interleave(kept.map((g) => g.filter((c) => !c.focus)), max);
  const seen = new Set<string>();
  return [...focused, ...rest].filter((c) => (seen.has(c.questionId) ? false : (seen.add(c.questionId), true))).slice(0, max);
}
