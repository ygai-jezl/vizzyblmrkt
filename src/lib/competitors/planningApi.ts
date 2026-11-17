import { NextResponse } from "next/server";
import { z } from "zod";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { fileSuggestions } from "@/lib/brandMap/filing";
import { fileBrandMapSuggestions, readBrandMap } from "@/lib/brandMap/store";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ArticleFormat, CompetitorArticle } from "@/lib/types/competitor";
import { articlesOnSubject } from "./articles";
import { competitorCoverage, COVERAGE_DAYS } from "./coverage";
import { isCompetitorArticlesPlanningEnabled } from "./flags";
import { listCompetitors } from "./store";
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
  /** Formats no competitor used on this subject: room to stand out. */
  nobodyHas: string[];
}

/** The formats worth noticing when nobody has used one on a subject. */
const NOTABLE: ArticleFormat[] = ["case_study", "research", "how_to", "comparison", "guide"];

/** What competitors wrote on one subject, for its panel. Pure. */
export function subjectCompetitorsOf(articles: CompetitorArticle[], names: Map<string, string>): SubjectCompetitors {
  const read = articles.filter((a) => a.status === "read" && names.has(a.competitorId));
  const byCompetitor = new Map<string, CompetitorArticle[]>();
  for (const a of read) byCompetitor.set(a.competitorId, [...(byCompetitor.get(a.competitorId) ?? []), a]);
  const used = new Set(read.flatMap((a) => (a.format ? [a.format] : [])));
  const seen = new Set<string>();
  return {
    total: read.length,
    competitors: [...byCompetitor.entries()]
      .map(([id, list]) => ({
        name: names.get(id)!,
        count: list.length,
        formats: [...new Set(list.flatMap((a) => (a.format ? [FORMAT_LABEL[a.format]] : [])))].slice(0, 3),
        asks: [...new Set(list.flatMap((a) => a.asks.map((x) => askLabel(x.kind))))].slice(0, 3),
        latest: { title: list[0]!.title, url: list[0]!.url, publishedAt: list[0]!.publishedAt },
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    angles: read
      .filter((a) => a.angle)
      .slice(0, 5)
      .map((a) => ({ competitor: names.get(a.competitorId)!, angle: a.angle, url: a.url })),
    stats: read
      .flatMap((a) => a.stats.filter((s) => !s.theirOwn && s.source).map((s) => ({ figure: s.figure, about: s.about, url: s.source!.url, domain: s.source!.domain })))
      .filter((s) => (seen.has(`${s.figure}|${s.domain}`) ? false : (seen.add(`${s.figure}|${s.domain}`), true)))
      .slice(0, 5),
    nobodyHas: read.length ? NOTABLE.filter((f) => !used.has(f)).map((f) => FORMAT_LABEL[f]) : [],
  };
}

const SUBJECT_ID = /^sub_[A-Za-z0-9_-]{4,80}$/;

export async function subjectCompetitorsFromRequest(ctx: TenantContext, subjectId: string, deps: PlanningApiDeps = {}): Promise<Response> {
  const blocked = await allowed(ctx, deps);
  if (blocked) return blocked;
  if (!SUBJECT_ID.test(subjectId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const [articles, competitors] = await Promise.all([articlesOnSubject(ctx, subjectId, deps), listCompetitors(ctx, deps)]);
  const names = new Map(competitors.map((c) => [c.id, c.name]));
  return NextResponse.json({ competitors: subjectCompetitorsOf(articles, names) }, { headers: noStore });
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
