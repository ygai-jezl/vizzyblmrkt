import { NextResponse } from "next/server";
import { listSituations } from "@/lib/brandMap/situations";
import { readBrandMap } from "@/lib/brandMap/store";
import { listRecentReadArticles } from "@/lib/competitors/articles";
import { coverageFrom, ourSubjects } from "@/lib/competitors/coverage";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { PROFILE_DAYS, competitorProfiles, profileLine, type SituationAgainst } from "@/lib/competitors/profile";
import { listCompetitors } from "@/lib/competitors/store";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import type { Competitor, CompetitorArticle } from "@/lib/types/competitor";
import type { Tenant } from "@/lib/types/tenant";
import { readBrandStrategyDoc } from "./store";

/**
 * The Strategy tab's view of the competitors' articles (STRATEGY_COMPETITORS_ENABLED), worked out
 * live from the last 90 days and never stored: one "What they write" line per watched competitor,
 * and the "Against your competitors" card. Reading competitors needs the brand's `competitors`
 * feature; reading their articles needs COMPETITOR_ARTICLES_ENABLED and `competitor_articles`.
 */

export interface StrategyCompetitorsView {
  /** Their articles can be read for this brand. */
  articles: boolean;
  days: number;
  /** A month had more reads than were looked at, so the counts may be low. */
  truncated: boolean;
  /** What they write: one line per watched competitor, and the counts it is made from. */
  profiles: Array<{ id: string; name: string; read: number; fromPage: number; line: string }>;
  against: {
    approvedAt: string | null;
    /** The approved strategy's focus situations; the tab picks the rows to show with focusAgainst. */
    approvedFocus: string[];
    /** Every decided situation, once: the tab picks its focus rows from these, so a star needs no new read. */
    rows: SituationAgainst[];
    /** Subjects on the brand map only competitors write on lately (the coverage page's Gap rows). */
    onlyThem: number;
    /** Alternatives on the brand map they name that the brand doesn't watch. */
    namedNotWatched: Array<{ name: string; count: number }>;
  } | null;
}

export interface CompetitorsViewDeps {
  db?: FirestoreLike;
  now?: () => Date;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

const noStore = { "cache-control": "no-store" };

/** Null when the brand doesn't have Competitors. */
export async function strategyCompetitorsView(ctx: TenantContext, deps: CompetitorsViewDeps = {}): Promise<StrategyCompetitorsView | null> {
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const load = async () => tenant;
  if (!isCompetitorsEnabled() || !(await brandCanUse(ctx, "competitors", load).catch(() => false))) return null;
  const empty: StrategyCompetitorsView = { articles: false, days: PROFILE_DAYS, truncated: false, profiles: [], against: null };
  if (!isCompetitorArticlesEnabled() || !(await brandCanUse(ctx, "competitor_articles", load).catch(() => false))) return empty;
  const now = (deps.now ?? (() => new Date()))();
  const [recent, competitors, situations, read, ours, doc] = await Promise.all([
    listRecentReadArticles(ctx, { db: deps.db, now: () => now, loadTenant: load }).catch(() => ({ articles: [] as CompetitorArticle[], truncated: false })),
    listCompetitors(ctx, { db: deps.db }).catch(() => [] as Competitor[]),
    listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]),
    readBrandMap(ctx, deps.db).catch(() => null),
    ourSubjects(ctx, { db: deps.db }).catch(() => ({ subjects: new Map(), moved: false, map: null })),
    readBrandStrategyDoc(ctx, { db: deps.db }).catch(() => null),
  ]);
  const articles = recent.articles;
  const view = competitorProfiles({
    articles,
    competitors,
    situations: situations.filter((s) => s.status === "decided").map((s) => ({ id: s.id, text: s.text, questions: s.counts.questions, answered: s.counts.answered })),
    alternatives: read?.state === "ok" ? read.map.names.filter((n) => n.kind === "alternative").map((n) => ({ name: n.name, aliases: n.aliases })) : [],
    nowMs: now.getTime(),
    since: doc?.approved?.at ? doc.approved.at.slice(0, 10) : null,
  });
  const coverage = coverageFrom(articles, competitors, ours.subjects, { nowMs: now.getTime(), allSubjects: false, maxRows: Number.MAX_SAFE_INTEGER });
  return {
    articles: true,
    days: view.days,
    truncated: recent.truncated,
    profiles: view.profiles.map((p) => ({ id: p.id, name: p.name, read: p.read, fromPage: p.fromPage, line: profileLine(p) })),
    against: {
      approvedAt: doc?.approved?.at ?? null,
      approvedFocus: doc?.approved?.focusSituationIds ?? [],
      rows: view.situations,
      onlyThem: coverage.rows.filter((r) => r.flag === "gap").length,
      namedNotWatched: view.namedNotWatched,
    },
  };
}

/** GET map/strategy/competitors: any member reads it. 403 `not_included` without Competitors. */
export async function competitorsFromRequest(ctx: TenantContext, deps: CompetitorsViewDeps = {}): Promise<Response> {
  const view = await strategyCompetitorsView(ctx, deps);
  if (!view) return NextResponse.json({ error: "not_included" }, { status: 403 });
  return NextResponse.json({ competitors: view }, { headers: noStore });
}
