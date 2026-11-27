import { fold } from "@/lib/brandMap/changes";
import type { ArticleAskKind, ArticleFormat, ArticleStage, Competitor, CompetitorArticle } from "@/lib/types/competitor";
import { COVERAGE_DAYS, articleDay, flagOf, windowStart } from "./coverage";
import type { SituationAgainst } from "./against";
import { FORMAT_WORDS, articleTotals, listWords, type ArticleTotals } from "./view";

export { focusAgainst, type SituationAgainst } from "./against";

/**
 * What each watched competitor writes, from the articles read in full over the last 90 days
 * (COVERAGE_DAYS), worked out by code when a page or Propose asks and never stored
 * (STRATEGY_COMPETITORS_ENABLED). Plain counts anyone can check against the articles.
 *
 *  - Totals: the same totals a competitor's page shows (articleTotals) for stages, formats,
 *    readers, asks and stats.
 *  - Situations: the 3 decided buying situations of the brand's they write on most.
 *  - Angles and proof: their 2 newest angles, and 2 article addresses to stand on.
 *  - Mentions: how many articles name the brand, and which alternatives on its map they name that
 *    it doesn't watch. The reader only matches names on the map, so this finds no new names.
 *  - Per situation: a label from flagOf(they, you, writers), where "you" is the questions the
 *    brand has answered with a live article.
 *
 * Stats, asks and "names you" count only articles read from their own pages: one read through
 * Google has none of them, so each profile says how many it counts over (`fromPage`). Pure.
 */

export const PROFILE_DAYS = COVERAGE_DAYS;
const TOP_SITUATIONS = 3;
const ANGLES = 2;
const PROOF = 2;
const NAMED = 5;

export interface ProfileSituation {
  id: string;
  text: string;
  count: number;
}

export interface CompetitorProfile {
  id: string;
  name: string;
  /** Articles read in the window. */
  read: number;
  /** Of those, the ones read from their own pages: stats, asks and names you count only these. */
  fromPage: number;
  totals: ArticleTotals;
  situations: ProfileSituation[];
  angles: string[];
  proof: Array<{ url: string; title: string }>;
  /** Articles that name the brand, of the ones read from their own pages. */
  namesYou: number;
  /** Alternatives on the brand's map they name that it doesn't watch, by how many articles name each. */
  namesOthers: Array<{ name: string; count: number }>;
}


export interface ProfilesView {
  days: number;
  /** The window's first day (YYYY-MM-DD): an article on it counts. */
  since: string;
  profiles: CompetitorProfile[];
  /** Every decided situation, as given. */
  situations: SituationAgainst[];
  /** Alternatives on the brand's map, not watched, that any of them names, most first. */
  namedNotWatched: Array<{ name: string; count: number }>;
}

export interface ProfileInput {
  /** Read articles: any window, the 90 days are taken here. */
  articles: CompetitorArticle[];
  competitors: Array<Pick<Competitor, "id" | "name">>;
  /** The brand's decided buying situations, with their questions and how many a live article answers. */
  situations: Array<{ id: string; text: string; questions: number; answered: number }>;
  /** The alternatives on the brand's map, with their other spellings. */
  alternatives: Array<{ name: string; aliases: string[] }>;
  nowMs: number;
  /** A day (YYYY-MM-DD): count each situation's articles from it too (the approval's day). */
  since?: string | null;
}

const newestFirst = (a: CompetitorArticle, b: CompetitorArticle) => (articleDay(b) ?? "").localeCompare(articleDay(a) ?? "") || a.id.localeCompare(b.id);
const fromPage = (a: CompetitorArticle) => a.readBy !== "google";
const byCount = <T extends { count: number; name?: string; text?: string }>(a: T, b: T) => b.count - a.count || (a.name ?? a.text ?? "").localeCompare(b.name ?? b.text ?? "");

/** Each article's alternatives on the map, named once per article, leaving out the watched ones. */
function alternativesNamed(a: CompetitorArticle, alternatives: ProfileInput["alternatives"], watched: Set<string>): string[] {
  if (!fromPage(a)) return [];
  const said = new Set(a.mentions.others.map(fold));
  return alternatives.filter((alt) => !watched.has(fold(alt.name)) && !alt.aliases.some((x) => watched.has(fold(x))) && [alt.name, ...alt.aliases].some((n) => said.has(fold(n)))).map((alt) => alt.name);
}

function tally(names: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort(byCount);
}

export function competitorProfiles(input: ProfileInput): ProfilesView {
  const since = windowStart(input.nowMs);
  const ids = new Set(input.competitors.map((c) => c.id));
  const recent = input.articles.filter((a) => a.status === "read" && ids.has(a.competitorId) && (articleDay(a) ?? "") >= since).sort(newestFirst);
  const decided = new Map(input.situations.map((s) => [s.id, s] as const));
  const watched = new Set(input.competitors.map((c) => fold(c.name)));

  const profiles = input.competitors.map((c): CompetitorProfile => {
    const theirs = recent.filter((a) => a.competitorId === c.id);
    const page = theirs.filter(fromPage);
    const onSituation = new Map<string, number>();
    for (const a of theirs) for (const id of new Set(a.situationIds)) if (decided.has(id)) onSituation.set(id, (onSituation.get(id) ?? 0) + 1);
    return {
      id: c.id,
      name: c.name,
      read: theirs.length,
      fromPage: page.length,
      totals: articleTotals(theirs),
      situations: [...onSituation]
        .map(([id, count]) => ({ id, text: decided.get(id)!.text, count }))
        .sort(byCount)
        .slice(0, TOP_SITUATIONS),
      angles: theirs.map((a) => a.angle.trim()).filter(Boolean).slice(0, ANGLES),
      proof: theirs.filter((a) => /^https:\/\//i.test(a.url)).slice(0, PROOF).map((a) => ({ url: a.url, title: a.title })),
      namesYou: page.filter((a) => a.mentions.you.length > 0).length,
      namesOthers: tally(theirs.flatMap((a) => alternativesNamed(a, input.alternatives, watched))).slice(0, NAMED),
    };
  });

  const names = new Map(input.competitors.map((c) => [c.id, c.name] as const));
  const situations = input.situations.map((s): SituationAgainst => {
    const on = recent.filter((a) => a.situationIds.includes(s.id));
    const counts = new Map<string, number>();
    for (const a of on) counts.set(a.competitorId, (counts.get(a.competitorId) ?? 0) + 1);
    const byCompetitor = [...counts].map(([id, count]) => ({ id, name: names.get(id) ?? "", count })).sort(byCount);
    return {
      id: s.id,
      text: s.text,
      they: on.length,
      byCompetitor,
      questions: s.questions,
      answered: s.answered,
      flag: flagOf(on.length, s.answered, byCompetitor.length),
      newSince: input.since ? on.filter((a) => (articleDay(a) ?? "") >= input.since!).length : null,
    };
  });

  return {
    days: PROFILE_DAYS,
    since,
    profiles,
    situations,
    namedNotWatched: tally(recent.flatMap((a) => alternativesNamed(a, input.alternatives, watched))).slice(0, NAMED),
  };
}


/** Who reads them, in a few words after "for". */
const STAGE_WORDS: Record<ArticleStage, string> = {
  awareness: "people just learning",
  consideration: "people weighing options",
  decision: "people ready to buy",
  retention: "people who are already customers",
};

/** What an ask pushes, after "pushes". */
const ASK_PUSHES: Record<ArticleAskKind, string> = {
  demo: "demos",
  trial: "free trials",
  sign_up: "sign ups",
  contact_sales: "talks with sales",
  download: "downloads",
  newsletter: "its newsletter",
  webinar: "webinars",
  pricing: "its pricing",
  other: "other asks",
};

/**
 * One line on what a competitor writes, by code from its profile: "Mostly news posts and research
 * pieces, for people just learning. 263 stats, pushes demos. Most on "Buyers now ask ChatGPT"." It
 * says when stats and asks count only some of the articles, or none (read through Google).
 */
export function profileLine(p: CompetitorProfile): string {
  if (!p.read) return "";
  const formats = p.totals.formats
    .filter((f) => f.key !== "listing")
    .slice(0, 2)
    .map((f) => (FORMAT_WORDS[f.key as ArticleFormat] ?? FORMAT_WORDS.other)[1]);
  const stage = p.totals.stages[0]?.key as ArticleStage | undefined;
  const who = p.totals.companies[0]?.key ?? (stage ? STAGE_WORDS[stage] : "");
  const ask = p.totals.asks[0]?.key as ArticleAskKind | undefined;
  const parts = [
    formats.length ? `Mostly ${listWords(formats)}${who ? `, for ${who}` : ""}.` : "",
    p.fromPage
      ? `${p.totals.stats.total} ${p.totals.stats.total === 1 ? "stat" : "stats"}${ask ? `, pushes ${ASK_PUSHES[ask]}` : ""}${p.fromPage < p.read ? `, in the ${p.fromPage} of ${p.read} read from their own pages` : ""}.`
      : "Read through Google, so no stats or asks.",
    p.namesYou ? `${p.namesYou} of ${p.fromPage} name you.` : "",
    p.situations[0] ? `Most on "${p.situations[0].text}".` : "",
  ];
  return parts.filter(Boolean).join(" ");
}
