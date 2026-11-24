import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { isConnectorSignalsEnabled } from "../flags";
import { feedsPlanning } from "../grants";
import { planningId, siteName } from "../keys";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { dayWords, zoneWords } from "../period";
import { readSnapshot } from "../snapshots";

/**
 * Search Console demand for planning (Connectors 2 group 4, CONNECTOR_SIGNALS_ENABLED): what Next up
 * and the context pack read, from the planning docs the lane writes once a day (a ready line per
 * brand map question whose words people searched, and per decided subject the searches nearest
 * it). Read by id, once per pick or pack. Only from connections both members and Vizzy may read:
 * Next up is stored once per brand and the pack goes to Vizzy, so neither can follow one viewer's
 * access. Every number sits in the line's words, so Next up's check that a reason names only
 * numbers its lines hold keeps the pick.
 */

const STREAM = searchConsoleManifest.produces[0]!.stream;

export interface SearchPlanningSite {
  connectionId: string;
  site: string;
  /** The 28 days (or as many as are collected) to the last collected day. */
  window: { from: string; to: string };
  days: number;
  timeZone: string | null;
  /** By brand map question id: the search with the question's words, and its numbers. */
  questions: Map<string, SnapshotRow>;
  /** By decided subject id: the nearby searches and their numbers. */
  subjects: Map<string, SnapshotRow>;
}

export interface SearchPlanning {
  sites: SearchPlanningSite[];
  /** The brand has Search Console, but no connection that members and Vizzy may both read. */
  notShared: boolean;
}

/** The line Next up says when Search Console isn't used for planning. */
export const NOT_SHARED_NEXT_UP = "Search Console isn't shared with your team and Vizzy, so its numbers weren't weighed.";

/** The brand's Search Console demand, or null while signals are off. */
export async function readSearchPlanning(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<SearchPlanning | null> {
  if (!isConnectorSignalsEnabled()) return null;
  const conns = (await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: 50 })).filter((c) => c.connectorId === searchConsoleManifest.id);
  const planning = conns.filter((c) => feedsPlanning(c.grants) && c.collect);
  const sites: SearchPlanningSite[] = [];
  for (const c of planning) {
    const gen = c.collect!.gen;
    const [q, s] = await Promise.all([readSnapshot(ctx, planningId(c.id, gen, STREAM, "question"), deps), readSnapshot(ctx, planningId(c.id, gen, STREAM, "subject"), deps)]);
    const doc = q ?? s;
    if (!doc?.window) continue;
    sites.push({
      connectionId: c.id,
      site: siteName(c.account),
      window: doc.window,
      days: doc.days ?? 28,
      timeZone: doc.timeZone,
      questions: new Map((q?.rows ?? []).map((r) => [r.key, r] as const)),
      subjects: new Map((s?.rows ?? []).map((r) => [r.key, r] as const)),
    });
  }
  return { sites, notShared: conns.length > 0 && !conns.some((c) => feedsPlanning(c.grants)) };
}

const n = (v: number | undefined) => Math.round(v ?? 0).toLocaleString("en-GB");
const position = (v: number | undefined) => (Math.round((v ?? 0) * 10) / 10).toFixed(1);

/** A Search Console line about one question: its words, the chip's words, and the numbers by meaning. */
export interface SearchConsoleLine {
  kind: "exact" | "subject";
  text: string;
  chip: string;
  site: string;
  m: Record<string, number>;
}

/**
 * Up to two lines for a question: the search with its exact words (the busiest site's), and the
 * searches near its subject. With more than one Search Console site, each names its site.
 */
export function searchConsoleLines(q: { questionId?: string | null; subjectId?: string | null }, planning: SearchPlanning | null): SearchConsoleLine[] {
  if (!planning?.sites.length) return [];
  const named = planning.sites.length > 1;
  const head = (s: SearchPlanningSite) => `Search Console${named ? `, ${s.site}` : ""} (${s.days} days to ${dayWords(s.window.to)}, ${zoneWords(s.timeZone)})`;
  const chipOf = (s: SearchPlanningSite, words: string) => (named ? `${s.site}: ${words}` : words);
  const busiest = (pick: (s: SearchPlanningSite) => SnapshotRow | undefined) =>
    planning.sites
      .map((s) => ({ s, r: pick(s) }))
      .filter((x): x is { s: SearchPlanningSite; r: SnapshotRow } => !!x.r)
      .sort((a, b) => (b.r.m.searchImpressions ?? 0) - (a.r.m.searchImpressions ?? 0))[0];
  const out: SearchConsoleLine[] = [];
  const exact = q.questionId ? busiest((s) => s.questions.get(q.questionId!)) : undefined;
  if (exact) {
    const m = exact.r.m;
    out.push({
      kind: "exact",
      site: exact.s.site,
      m,
      text: `${head(exact.s)}: the search "${exact.r.label ?? ""}" had ${n(m.searchImpressions)} impressions and ${n(m.searchClicks)} clicks, average position ${position(m.searchPosition)}.`,
      chip: chipOf(exact.s, `${n(m.searchImpressions)} impressions, position ${position(m.searchPosition)}`),
    });
  }
  const near = q.subjectId ? busiest((s) => s.subjects.get(q.subjectId!)) : undefined;
  if (near && (near.r.m.nearbySearches ?? 0) > 0) {
    const m = near.r.m;
    out.push({
      kind: "subject",
      site: near.s.site,
      m,
      text: `${head(near.s)}: ${n(m.nearbySearches)} search${m.nearbySearches === 1 ? "" : "es"} near this subject had ${n(m.searchImpressions)} impressions and ${n(m.searchClicks)} clicks.`,
      chip: chipOf(near.s, `${n(m.nearbySearches)} nearby search${m.nearbySearches === 1 ? "" : "es"}, ${n(m.searchImpressions)} impressions`),
    });
  }
  return out;
}
