import { fold } from "@/lib/brandMap/changes";
import type { Competitor } from "@/lib/types/competitor";
import {
  BRAND_STRATEGY_LIMITS as L,
  competitorsOf,
  groupsOf,
  type CompetitorGroupKind,
  type NotCompetitor,
  type Strategy,
  type StrategyCompetitor,
  type StrategyCompetitorGroup,
} from "@/lib/types/brandStrategy";

/**
 * One competitor list behind two doors (STRATEGY_COMPETITORS_ENABLED): the Strategy tab's "Who you
 * compete with" and Brand › Competitors read the same list, worked out live, never stored. Pure
 * and client safe.
 *
 *  - First every competitor the brand watches, before any Propose too. Its group is the one a
 *    person chose on the competitor, else the one an older draft gave it, else none ("Not grouped
 *    yet").
 *  - Then what the finder suggested that isn't watched (matched by site, or by the name folded),
 *    leaving out every name a person marked Not a competitor.
 *  - A draft entry copied in as watched that the brand no longer watches drops out.
 *
 * `watched` is null when the brand can't read its competitors (it doesn't have the feature): the
 * draft's list then shows as it is, with its ticks.
 */

/** A competitor as both doors show it. */
export type LiveCompetitor = StrategyCompetitor & {
  /** Its record on Brand › Competitors when watched; null for a suggestion. */
  id: string | null;
  group: CompetitorGroupKind | null;
  monitored: boolean;
};

type Watched = Pick<Competitor, "id" | "name" | "site" | "group">;
type Named = { name: string; site: string | null };

/** The same competitor: the same site, or the same name once folded. */
export const sameCompetitor = (a: Named, b: Named) => Boolean((a.site && b.site && a.site === b.site) || fold(a.name) === fold(b.name));

/** Whether a person marked this one Not a competitor. */
export const isNotCompetitor = (c: Named, not: NotCompetitor[]) => not.some((n) => sameCompetitor(n, c));

export function liveCompetitors(draft: Pick<Strategy, "competitorGroups"> | null, watched: Watched[] | null, notCompetitors: NotCompetitor[]): LiveCompetitor[] {
  const entries = draft ? competitorsOf(draft) : [];
  if (!watched) {
    return entries.filter((c) => !(c.from === "finder" && isNotCompetitor(c, notCompetitors))).map((c) => ({ ...c, id: null, monitored: false }));
  }
  const used = new Set<number>();
  const out: LiveCompetitor[] = watched.map((w) => {
    const named = { name: w.name, site: w.site || null };
    const at = entries.findIndex((e, i) => !used.has(i) && sameCompetitor(e, named));
    const entry = at >= 0 ? entries[at] : undefined;
    // Every entry for it is its own: a second copy never shows as a suggestion.
    entries.forEach((e, i) => sameCompetitor(e, named) && used.add(i));
    return {
      name: w.name,
      site: named.site,
      foundTimes: entry?.foundTimes ?? 0,
      evidence: entry?.evidence ?? [],
      ticked: true,
      from: entry?.from === "finder" ? "finder" : "watched",
      id: w.id,
      group: w.group ?? entry?.group ?? null,
      monitored: true,
    };
  });
  entries.forEach((e, i) => {
    if (used.has(i) || e.from === "watched" || isNotCompetitor(e, notCompetitors)) return;
    out.push({ ...e, id: null, monitored: false });
  });
  return out;
}

/** Only the finder's suggestions: what both doors offer to Monitor or mark Not a competitor. */
export const suggestionsOf = (list: LiveCompetitor[]) => list.filter((c) => !c.monitored && c.from === "finder");

/**
 * The live list as approval keeps it, the history copy: the grouped ones in their groups (watched
 * ones first and all kept), and the watched ones nobody grouped. Pure.
 */
export function approvedCopy(list: LiveCompetitor[]): { competitorGroups: StrategyCompetitorGroup[]; ungrouped: StrategyCompetitor[] } {
  const plain = ({ id: _i, monitored: _m, group: _g, ...c }: LiveCompetitor): StrategyCompetitor => {
    void _i;
    void _m;
    void _g;
    return c;
  };
  return {
    competitorGroups: groupsOf(list.flatMap((c) => (c.group ? [{ ...plain(c), group: c.group }] : []))),
    ungrouped: list.filter((c) => !c.group && c.monitored).map(plain).slice(0, L.keptPerGroup),
  };
}
