import { cutOff, type CutOff } from "@/lib/search/family";
import { isSearchCompetitorReadsEnabled } from "@/lib/search/flags";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { TenantContext } from "@/lib/tenant/types";
import type { ArticleFormat, CompetitorArticle } from "@/lib/types/competitor";
import { articlesOnSubject, nearestCompetitorArticles, type ArticleStoreDeps } from "./articles";
import { isCompetitorArticlesPlanningEnabled } from "./flags";
import { listCompetitors } from "./store";
import { FORMAT_LABEL } from "./view";

/**
 * What competitors wrote, for planning (COMPETITOR_ARTICLES_PLANNING_ENABLED): the angles they
 * already took on a subject or question, the questions their articles answer, and the numbers
 * they cite from outside sources. A competitor's own data is never offered as a fact: only a
 * number an outside page backs, as a lead that research checks again at that page.
 *
 * Everything here came from a competitor's page through a model, so callers put it inside a
 * fence marked UNTRUSTED DATA.
 */

export interface PlanningDeps extends ArticleStoreDeps {
  /** Whether this brand has the feature (tests). */
  canUse?: (ctx: TenantContext) => Promise<boolean>;
}

export interface TakenAngle {
  competitor: string;
  title: string;
  angle: string;
  question: string;
  format: ArticleFormat | null;
  publishedAt: string | null;
}

export interface OutsideStat {
  figure: string;
  about: string;
  url: string;
  domain: string;
}

export interface CompetitorContext {
  angles: TakenAngle[];
  stats: OutsideStat[];
}

/** Articles offered to one planning step, at most. */
const MAX_ANGLES = 6;
const MAX_STATS = 6;
/**
 * How close in meaning an article must be to count as on the same question: on brand_map_vectors
 * (`old`), or on brand search with SEARCH_COMPETITOR_READS_ENABLED (`new`, provisional until
 * scripts/measure-question-dupes.ts --model new is run, ADR-0025).
 */
export const MIN_SIM: CutOff = { old: 0.65, new: 0.65 };

/** What competitors wrote on a subject or near a question, or null (switch off, not granted, nothing found). */
export async function competitorContext(
  ctx: TenantContext,
  ask: { subjectId?: string | null; text?: string | null },
  deps: PlanningDeps = {},
): Promise<CompetitorContext | null> {
  if (!isCompetitorArticlesPlanningEnabled()) return null;
  if (!(await (deps.canUse ?? ((c) => brandCanUse(c, "competitor_articles")))(ctx).catch(() => false))) return null;
  const text = (ask.text ?? "").trim();
  const [onSubject, near, competitors] = await Promise.all([
    ask.subjectId ? articlesOnSubject(ctx, ask.subjectId, deps).catch(() => []) : Promise.resolve([] as CompetitorArticle[]),
    text ? nearestCompetitorArticles(ctx, text, { limit: MAX_ANGLES, minSim: cutOff(MIN_SIM, isSearchCompetitorReadsEnabled()) }, deps).catch(() => []) : Promise.resolve([]),
    listCompetitors(ctx, deps).catch(() => []),
  ]);
  const names = new Map(competitors.map((c) => [c.id, c.name]));
  // Nearest the question first, then the subject's newest; each article once, and only from competitors still watched.
  const seen = new Set<string>();
  const articles = [...near.map((n) => n.article), ...onSubject].filter((a) => names.has(a.competitorId) && (seen.has(a.id) ? false : (seen.add(a.id), true)));
  if (!articles.length) return null;

  const angles = articles
    .filter((a) => a.angle || a.question)
    .slice(0, MAX_ANGLES)
    .map((a) => ({ competitor: names.get(a.competitorId)!, title: a.title, angle: a.angle, question: a.question, format: a.format, publishedAt: a.publishedAt }));
  const statKeys = new Set<string>();
  const stats = articles
    .flatMap((a) => a.stats.filter((s) => !s.theirOwn && s.source).map((s) => ({ figure: s.figure, about: s.about, url: s.source!.url, domain: s.source!.domain })))
    .filter((s) => {
      const key = `${s.figure}|${s.domain}`;
      return statKeys.has(key) ? false : (statKeys.add(key), true);
    })
    .slice(0, MAX_STATS);
  return { angles, stats };
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** The angles taken, one line each: "- Rival (case study, 2026-11-16): Better forms beat more traffic." */
export function anglesBlock(c: CompetitorContext | null): string {
  return (c?.angles ?? [])
    .filter((a) => a.angle)
    .map((a) => `- ${one(a.competitor)} (${[a.format ? FORMAT_LABEL[a.format].toLowerCase() : "", a.publishedAt ?? ""].filter(Boolean).join(", ")}): ${one(a.angle)}`)
    .join("\n");
}

/** The questions their articles answer, one line each. */
export function questionsBlock(c: CompetitorContext | null): string {
  return [...new Set((c?.angles ?? []).map((a) => one(a.question)).filter(Boolean))].map((q) => `- ${q}`).join("\n");
}

/** Outside numbers they cite, with the page each came from, one line each. */
export function statsBlock(c: CompetitorContext | null): string {
  return (c?.stats ?? []).map((s) => `- ${one(s.figure)}${s.about ? ` (${one(s.about)})` : ""}: ${s.url}`).join("\n");
}
