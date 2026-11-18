import { NextResponse } from "next/server";
import { z } from "zod";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { fileSuggestions } from "@/lib/brandMap/filing";
import { fileBrandMapSuggestions, readBrandMap } from "@/lib/brandMap/store";
import { subjectQuestions } from "@/lib/brandMap/records";
import { isSuggestAngleEnabled } from "@/lib/content/create/flags";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { ArticleFormat, CompetitorArticle } from "@/lib/types/competitor";
import type { embedQuery } from "@/lib/agents/embeddings";
import { articlesOnSubject, questionsNobodyCovers } from "./articles";
import { competitorCoverage, competitorSubjectFlags, COVERAGE_DAYS } from "./coverage";
import { isCompetitorArticlesPlanningEnabled } from "./flags";
import { listCompetitors } from "./store";
import { cleanTitle } from "./titles";
import { FORMAT_LABEL, askLabel } from "./view";

/**
 * Planning's side of competitor articles (COMPETITOR_ARTICLES_PLANNING_ENABLED): what competitors
 * wrote on one brand map subject (for its panel), and filing subjects they write about that the
 * map lacks as suggestions a person decides on. The routes check origin, switch, sign-in and role.
 */

export interface PlanningApiDeps {
  db?: FirestoreLike;
  now?: () => Date;
  canUse?: (ctx: TenantContext) => Promise<boolean>;
  /** Test seams: a subject's questions, and meaning. */
  questions?: (ctx: TenantContext, subjectId: string) => Promise<Array<{ id: string; text: string; status: string }>>;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

const noStore = { "cache-control": "no-store" };

async function allowed(ctx: TenantContext, deps: PlanningApiDeps): Promise<Response | null> {
  if (!isCompetitorArticlesPlanningEnabled()) return NextResponse.json({ error: "competitor_articles_disabled" }, { status: 503 });
  if (!(await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_articles")))(ctx))) return NextResponse.json({ error: "not_included" }, { status: 403 });
  return null;
}

export interface SubjectCompetitors {
  total: number;
  competitors: Array<{ name: string; count: number; formats: string[]; asks: string[]; latest: { title: string; url: string; publishedAt: string | null } }>;
  angles: Array<{ competitor: string; angle: string; url: string }>;
  stats: Array<{ figure: string; about: string; url: string; domain: string }>;
  /** Formats no competitor used on this subject, as words after "written": room to stand out. */
  nobodyHas: string[];
  /** The subject's questions no competitor article is near in meaning (ids, in the subject's order). */
  uncovered: string[];
  /** Whether Write this next opens with an angle suggested (CREATE_SUGGEST_ANGLE_ENABLED). */
  suggestAngle: boolean;
}

/** The formats worth noticing when nobody has used one on a subject, as they read after "written". */
const NOTABLE: Array<[ArticleFormat, string]> = [
  ["case_study", "a case study"],
  ["research", "research"],
  ["how_to", "a how to"],
  ["comparison", "a comparison"],
  ["guide", "a guide"],
];

/** Questions checked against their articles' meaning, at most, per subject. */
const CHECK_QUESTIONS = 6;
/** As close in meaning as planning's other matches (planning.ts MIN_SIM). */
const COVERED_SIM = 0.65;

/** Who a competitor is: its name, and its site to take off the end of titles. */
export type CompetitorNames = Map<string, { name: string; site: string }>;

/** What competitors wrote on one subject, for its panel. Pure. */
export function subjectCompetitorsOf(articles: CompetitorArticle[], names: CompetitorNames): Omit<SubjectCompetitors, "uncovered" | "suggestAngle"> {
  const read = articles.filter((a) => a.status === "read" && names.has(a.competitorId));
  const byCompetitor = new Map<string, CompetitorArticle[]>();
  for (const a of read) byCompetitor.set(a.competitorId, [...(byCompetitor.get(a.competitorId) ?? []), a]);
  const used = new Set(read.flatMap((a) => (a.format ? [a.format] : [])));
  const seen = new Set<string>();
  return {
    total: read.length,
    competitors: [...byCompetitor.entries()]
      .map(([id, list]) => {
        const who = names.get(id)!;
        return {
          name: who.name,
          count: list.length,
          formats: [...new Set(list.flatMap((a) => (a.format ? [FORMAT_LABEL[a.format]] : [])))].slice(0, 3),
          asks: [...new Set(list.flatMap((a) => a.asks.filter((x) => x.kind !== "other").map((x) => askLabel(x.kind))))].slice(0, 3),
          latest: { title: cleanTitle(list[0]!.title, [who.name, who.site]), url: list[0]!.url, publishedAt: list[0]!.publishedAt },
        };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    angles: firstOfEach(read.filter((a) => a.angle))
      .slice(0, 5)
      .map((a) => ({ competitor: names.get(a.competitorId)!.name, angle: a.angle, url: a.url })),
    stats: read
      .flatMap((a) => a.stats.filter((s) => !s.theirOwn && s.source).map((s) => ({ figure: s.figure, about: s.about, url: s.source!.url, domain: s.source!.domain })))
      .filter((s) => (seen.has(`${s.figure}|${s.domain}`) ? false : (seen.add(`${s.figure}|${s.domain}`), true)))
      .slice(0, 5),
    nobodyHas: read.length ? NOTABLE.filter(([f]) => !used.has(f)).map(([, words]) => words) : [],
  };
}

/** One from each competitor first (newest first), then the rest: one competitor can't fill a short list. */
function firstOfEach(list: CompetitorArticle[]): CompetitorArticle[] {
  const seen = new Set<string>();
  const first: CompetitorArticle[] = [];
  const rest: CompetitorArticle[] = [];
  for (const a of list) (seen.has(a.competitorId) ? rest : (seen.add(a.competitorId), first)).push(a);
  return [...first, ...rest];
}

const SUBJECT_ID = /^sub_[A-Za-z0-9_-]{4,80}$/;

export async function subjectCompetitorsFromRequest(ctx: TenantContext, subjectId: string, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  if (!SUBJECT_ID.test(subjectId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const [articles, competitors] = await Promise.all([articlesOnSubject(ctx, subjectId, deps), listCompetitors(ctx, deps)]);
  const names: CompetitorNames = new Map(competitors.map((c) => [c.id, { name: c.name, site: c.site }]));
  const view = subjectCompetitorsOf(articles, names);
  // Which of the subject's questions their articles don't answer: only worth asking when they wrote on it.
  let uncovered: string[] = [];
  if (view.total) {
    const questions = await (deps.questions ?? ((c, id) => subjectQuestions(c, id, { db: deps.db })))(ctx, subjectId).catch(() => []);
    const checked = questions.filter((q) => q.status === "decided" && q.text.trim()).slice(0, CHECK_QUESTIONS);
    uncovered = (await questionsNobodyCovers(ctx, checked, COVERED_SIM, deps)) ?? [];
  }
  return NextResponse.json({ competitors: { ...view, uncovered, suggestAngle: isSuggestAngleEnabled() } }, { headers: noStore });
}

/** How much competitors wrote on each subject, and what it means, for the subject list. */
export async function subjectFlagsFromRequest(ctx: TenantContext, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  const subjects = await competitorSubjectFlags(ctx, { ...deps, canUse: async () => true });
  return NextResponse.json({ subjects: subjects ?? {} }, { headers: noStore });
}

const SuggestBody = z.object({ topics: z.array(z.string().trim().min(2).max(80)).min(1).max(10) });

/** File subjects they write about, and the map lacks, as suggestions from Competitors. Only topics the page offered. */
export async function suggestTopicsFromRequest(ctx: TenantContext, body: unknown, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  const parsed = SuggestBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const view = await competitorCoverage(ctx, { ...deps, canUse: async () => true });
  const wanted = new Set(parsed.data.topics.map((t) => t.toLowerCase()));
  const topics = (view?.notOnMap ?? []).filter((t) => wanted.has(t.topic.toLowerCase()));
  if (!topics.length) return NextResponse.json({ filed: 0 });
  const items = topics.map((t) => ({
    change: { type: "add_subject" as const, name: t.topic },
    reason: `${t.competitors.join(" and ")} wrote ${t.count} article${t.count === 1 ? "" : "s"} about it in the last ${COVERAGE_DAYS} days.`,
  }));
  const read = await readBrandMap(ctx, deps.db);
  const moved = read.state === "ok" && Boolean(read.map.moved);
  // A small map gets plain suggestions: filing proposals would move it to records.
  if (isBrandMapScaleEnabled() && moved) {
    const r = await fileSuggestions(ctx, { from: "competitors", items }, { db: deps.db });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ filed: r.value.filed.length + r.value.proposed.length });
  }
  const r = await fileBrandMapSuggestions(ctx, { from: "competitors", items }, { db: deps.db });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ filed: r.value.filed.length });
}
