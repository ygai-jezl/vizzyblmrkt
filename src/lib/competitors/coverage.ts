import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { listSubjects } from "@/lib/brandMap/records";
import { decidedBrandMap } from "@/lib/brandMap/store";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import { listArticles, listReadArticles } from "./articles";
import { isCompetitorArticlesEnabled } from "./flags";
import { listCompetitors } from "./store";

/**
 * What competitors write about, beside what the brand covers: one row per subject on the brand's
 * map. "You" counts the subject's questions the brand has answered, drafted or planned.
 */

export interface CoverageDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Whether this brand has the feature (tests). */
  canUse?: (ctx: TenantContext) => Promise<boolean>;
}

/** The window the page looks at. */
export const COVERAGE_DAYS = 90;
const MAX_ROWS = 40;
const MAX_TOPICS = 10;

export type CoverageFlag = "gap" | "open" | "crowded" | "you_lead" | "even";

export interface CoverageRow {
  subjectId: string;
  name: string;
  /** Competitor id → articles on this subject in the window. */
  byCompetitor: Record<string, number>;
  they: number;
  you: number;
  flag: CoverageFlag;
}

export interface CoverageView {
  days: number;
  competitors: Array<{ id: string; name: string }>;
  rows: CoverageRow[];
  articles: number;
  /** Subjects they write about that aren't on the brand's map, in a few words each. */
  notOnMap: Array<{ topic: string; count: number; competitors: string[] }>;
}

export interface OurSubject {
  name: string;
  you: number;
}

/**
 * What a row means: nobody writes on it (open), only they do (gap), two or more of them write
 * twice as much as you (crowded, so a new angle is needed), you write as much as they do (you
 * lead), or neither.
 */
export function flagOf(they: number, you: number, writers: number): CoverageFlag {
  if (they === 0) return you === 0 ? "open" : "you_lead";
  if (you === 0) return "gap";
  if (writers >= 2 && they >= you * 2) return "crowded";
  if (you >= they) return "you_lead";
  return "even";
}

const dayOf = (a: Pick<CompetitorArticle, "publishedAt" | "readAt">) => a.publishedAt ?? a.readAt?.slice(0, 10) ?? null;

/** The rows and topics, from read articles, the competitors and the brand's subjects. Pure. */
export function coverageFrom(
  articles: CompetitorArticle[],
  competitors: Array<Pick<Competitor, "id" | "name">>,
  subjects: Map<string, OurSubject>,
  opts: { nowMs: number; allSubjects: boolean },
): CoverageView {
  const since = new Date(opts.nowMs - COVERAGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const names = new Map(competitors.map((c) => [c.id, c.name]));
  const recent = articles.filter((a) => a.status === "read" && names.has(a.competitorId) && (dayOf(a) ?? "") >= since);

  const counts = new Map<string, Record<string, number>>();
  const topics = new Map<string, { topic: string; count: number; competitors: Set<string> }>();
  for (const a of recent) {
    const onMap = a.subjectIds.filter((id) => subjects.has(id));
    for (const id of onMap) {
      const row = counts.get(id) ?? {};
      row[a.competitorId] = (row[a.competitorId] ?? 0) + 1;
      counts.set(id, row);
    }
    if (!onMap.length && a.newTopic) {
      const key = a.newTopic.trim().toLowerCase();
      const t = topics.get(key) ?? { topic: a.newTopic.trim(), count: 0, competitors: new Set<string>() };
      t.count += 1;
      t.competitors.add(names.get(a.competitorId)!);
      topics.set(key, t);
    }
  }

  const ids = opts.allSubjects ? [...subjects.keys()] : [...counts.keys()];
  const rows = ids
    .map((subjectId) => {
      const byCompetitor = counts.get(subjectId) ?? {};
      const they = Object.values(byCompetitor).reduce((n, x) => n + x, 0);
      const s = subjects.get(subjectId)!;
      return { subjectId, name: s.name, byCompetitor, they, you: s.you, flag: flagOf(they, s.you, Object.keys(byCompetitor).length) };
    })
    .sort((a, b) => b.they - a.they || a.you - b.you || a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS);

  return {
    days: COVERAGE_DAYS,
    competitors: competitors.map((c) => ({ id: c.id, name: c.name })),
    rows,
    articles: recent.length,
    notOnMap: [...topics.values()]
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
      .slice(0, MAX_TOPICS)
      .map((t) => ({ topic: t.topic, count: t.count, competitors: [...t.competitors].sort() })),
  };
}

/** The brand's decided subjects, with how many of each one's questions it has answered, drafted or planned. */
export async function ourSubjects(ctx: TenantContext, deps: CoverageDeps = {}): Promise<{ subjects: Map<string, OurSubject>; moved: boolean }> {
  const map = await decidedBrandMap(ctx, deps.db).catch(() => null);
  if (!map) return { subjects: new Map(), moved: false };
  if (isBrandMapScaleEnabled() && map.moved) {
    const rows = await listSubjects(ctx, { status: "decided" }, { db: deps.db }).catch(() => []);
    return {
      subjects: new Map(rows.filter((r) => !r.mergedInto).map((r) => [r.id, { name: r.name, you: r.counts.answered + r.counts.drafted + r.counts.planned }])),
      moved: true,
    };
  }
  const pages = await listBrandMapPages(ctx, deps.db).catch(() => []);
  const coverage = computeCoverage(map, pages);
  return {
    subjects: new Map(coverage.subjects.map((s) => [s.id, { name: s.name, you: s.questions.filter((q) => q.state !== "open").length }])),
    moved: false,
  };
}

async function mayRead(ctx: TenantContext, deps: CoverageDeps): Promise<boolean> {
  return isCompetitorArticlesEnabled() && (await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_articles")))(ctx));
}

/** A competitor's articles for its page, or null when this brand doesn't have them. */
export async function articlesForDetail(
  ctx: TenantContext,
  competitorId: string,
  deps: CoverageDeps = {},
): Promise<{ list: CompetitorArticle[]; subjectNames: Record<string, string> } | null> {
  if (!(await mayRead(ctx, deps))) return null;
  const [list, ours] = await Promise.all([listArticles(ctx, competitorId, deps), ourSubjects(ctx, deps)]);
  const subjectNames: Record<string, string> = {};
  for (const a of list) for (const id of a.subjectIds) if (ours.subjects.has(id)) subjectNames[id] = ours.subjects.get(id)!.name;
  return { list, subjectNames };
}

/** The whole page: every competitor, every read article, every subject. Null when this brand doesn't have it. */
export async function competitorCoverage(ctx: TenantContext, deps: CoverageDeps = {}): Promise<CoverageView | null> {
  if (!(await mayRead(ctx, deps))) return null;
  const [articles, competitors, ours] = await Promise.all([listReadArticles(ctx, deps), listCompetitors(ctx, deps), ourSubjects(ctx, deps)]);
  // A small map shows every subject (open ones too); a moved map only the ones competitors wrote about.
  return coverageFrom(articles, competitors, ours.subjects, { nowMs: (deps.now ?? (() => new Date()))().getTime(), allSubjects: !ours.moved });
}
