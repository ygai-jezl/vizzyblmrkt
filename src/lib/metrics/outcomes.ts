import type { ConnectorManifest, ConnectorUse, LiveBy } from "@/lib/connectors/manifest";
import { needsPage } from "@/lib/connectors/mcp/result";
import type { ConnectionGrant, HealthState } from "@/lib/types/dataConnection";
import type { MeaningKey } from "./meanings";

/**
 * The kinds of result a brand's work can lead to, read from whatever it has connected, never from
 * a named vendor (STRATEGY_RESULTS_ENABLED, ADR-0019). Each kind names the kinds of data
 * (`USES`) and the numbers, by meaning, that can measure it, in order of choice; a connector joins
 * by declaring its use and giving those numbers in its manifest. Pure and client safe: the Strategy
 * tab, Vizzy and the monthly look (src/lib/brandStrategy/month.ts) all read it.
 *
 * - One connection supplies each kind, so nothing counts twice: the first source in order whose
 *   connection is connected and shared with the team and Vizzy (feedsPlanning), then the one that
 *   matched the most of the brand's article pages, then the oldest. The others are "also connected".
 * - A kind nothing measures says why: not shared, the read failed, or not connected, with the
 *   connectors this build offers that could give it, each linked to its Connect page.
 */

export const OUTCOME_KINDS = ["search", "visits", "key_actions", "ai_answers"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** One way to measure a kind: a kind of data, its numbers by meaning (the first is the one shown) and how it is grouped. */
export interface OutcomeSource {
  use: ConnectorUse;
  measures: readonly MeaningKey[];
  by: LiveBy;
  /** Whole site only: its numbers can't be split by page, so it is only ever a site total. */
  siteOnly: boolean;
}

export interface Outcome {
  kind: OutcomeKind;
  /** What screens call it. */
  label: string;
  /** Its column on How it went. */
  column: string;
  /** What it lets the strategy tell, after "to see". */
  tells: string;
  /** What it counts, in a sentence: "visits", "sign-ups". */
  noun: string;
  sources: readonly OutcomeSource[];
}

export const OUTCOMES: Readonly<Record<OutcomeKind, Outcome>> = {
  search: {
    kind: "search",
    label: "Found in search",
    column: "Search clicks",
    tells: "which focus situations people find you for in search",
    noun: "clicks from search",
    sources: [{ use: "signals.search", measures: ["searchClicks", "searchImpressions"], by: "page", siteOnly: false }],
  },
  visits: {
    kind: "visits",
    label: "Visits",
    column: "Visits",
    tells: "which focus situations bring visits",
    noun: "visits",
    sources: [
      // Sessions by the page they began on: an article's own visits.
      { use: "signals.traffic", measures: ["ga4Sessions"], by: "landing", siteOnly: false },
      // A zone's daily totals: the whole site, never one article.
      { use: "signals.bots", measures: ["cfVisits"], by: "day", siteOnly: true },
    ],
  },
  key_actions: {
    kind: "key_actions",
    label: "Sign-ups and key actions",
    column: "Key actions",
    tells: "which focus situations bring sign-ups",
    noun: "sign-ups and key actions",
    sources: [{ use: "signals.traffic", measures: ["ga4KeyEvents"], by: "landing", siteOnly: false }],
  },
  ai_answers: {
    kind: "ai_answers",
    label: "Cited in AI answers",
    column: "AI citations",
    tells: "which focus situations get you cited in AI answers",
    noun: "citations in AI answers",
    sources: [{ use: "signals.ai_answers", measures: ["aiCitations"], by: "page", siteOnly: false }],
  },
};

/** Where a person connects a connector, and where one connection's grants and health are. */
export const connectHref = (connectorId: string) => `/admin/account/connections/${encodeURIComponent(connectorId)}`;
export const connectionHref = (connectionId: string) => `/admin/account/connections/connected?c=${encodeURIComponent(connectionId)}`;

/** What coverage needs of a connection: never its secrets. */
export interface CoverageConnection {
  id: string;
  connectorId: string;
  status: string;
  account: string;
  grants: readonly ConnectionGrant[];
  createdAt: string;
  health?: { state: HealthState } | null;
}

export type KindCoverage =
  | {
      kind: OutcomeKind;
      state: "measured";
      connectionId: string;
      connectorId: string;
      connector: string;
      /** The number shown, by meaning. */
      measure: MeaningKey;
      siteOnly: boolean;
      alsoConnected: Array<{ connectionId: string; connector: string }>;
    }
  | { kind: OutcomeKind; state: "not_shared"; connectionId: string; connectorId: string; connector: string; href: string }
  | { kind: OutcomeKind; state: "failed"; connectionId: string; connectorId: string; connector: string; href: string }
  | { kind: OutcomeKind; state: "not_connected"; could: Array<{ connectorId: string; name: string; href: string; siteOnly: boolean }> };

export type CoverageState = KindCoverage["state"];

export interface CoverageOptions {
  /** How many of the brand's article pages each connection's read matched (readOutcomes). */
  matched?: Readonly<Record<string, number>>;
  /** Connections whose read failed this time. */
  failed?: Iterable<string>;
}

/** Both members and Vizzy may read it: the one rule for numbers the whole team sees (grants.ts feedsPlanning). */
const shared = (grants: readonly ConnectionGrant[]) => ["members", "agent:vizzy"].every((to) => grants.some((g) => g.to === to && g.can === "read"));

/** Whether a manifest gives a source: it declares the use, and one stream gives every number, grouped so, for the whole account. */
export function givesSource(m: Pick<ConnectorManifest, "uses" | "produces">, s: OutcomeSource): boolean {
  return m.uses.includes(s.use) && m.produces.some((p) => !p.personal && p.liveBy.includes(s.by) && s.measures.every((k) => p.measures.includes(k)) && !needsPage(p.mcp));
}

/**
 * For each kind of result, in OUTCOME_KINDS order: measured (and from which connection), not shared,
 * failed, or not connected (with what could give it). `catalog` is the connectors offered in this
 * build (registry.ts listConnectors); a connection to one that isn't offered counts for nothing.
 * Pure.
 */
export function outcomeCoverage(connections: readonly CoverageConnection[], catalog: readonly ConnectorManifest[], opts: CoverageOptions = {}): KindCoverage[] {
  const manifests = new Map(catalog.map((m) => [m.id, m] as const));
  const failed = new Set(opts.failed ?? []);
  const matched = opts.matched ?? {};
  const live = connections.filter((c) => c.status === "connected" && c.account && manifests.has(c.connectorId));
  const nameOf = (c: CoverageConnection) => manifests.get(c.connectorId)!.name;
  const broken = (c: CoverageConnection) => failed.has(c.id) || c.health?.state === "broken";
  const best = (a: CoverageConnection, b: CoverageConnection) => (matched[b.id] ?? 0) - (matched[a.id] ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  return OUTCOME_KINDS.map((kind): KindCoverage => {
    const outcome = OUTCOMES[kind];
    const bySource = outcome.sources.map((s) => ({ s, list: live.filter((c) => givesSource(manifests.get(c.connectorId)!, s)) }));
    const usable = bySource.map(({ s, list }) => ({ s, list: list.filter((c) => shared(c.grants) && !broken(c)).sort(best) }));
    const pick = usable.find((u) => u.list.length);
    if (pick) {
      const chosen = pick.list[0]!;
      const others = usable.flatMap((u) => u.list).filter((c, i, all) => c.id !== chosen.id && all.findIndex((x) => x.id === c.id) === i);
      return {
        kind,
        state: "measured",
        connectionId: chosen.id,
        connectorId: chosen.connectorId,
        connector: nameOf(chosen),
        measure: pick.s.measures[0]!,
        siteOnly: pick.s.siteOnly,
        alsoConnected: others.map((c) => ({ connectionId: c.id, connector: nameOf(c) })),
      };
    }
    const all = bySource.flatMap((b) => b.list);
    const down = all.find((c) => shared(c.grants) && broken(c));
    if (down) return { kind, state: "failed", connectionId: down.id, connectorId: down.connectorId, connector: nameOf(down), href: connectionHref(down.id) };
    const closed = all.find((c) => !shared(c.grants));
    if (closed) return { kind, state: "not_shared", connectionId: closed.id, connectorId: closed.connectorId, connector: nameOf(closed), href: connectionHref(closed.id) };
    const could: Array<{ connectorId: string; name: string; href: string; siteOnly: boolean }> = [];
    for (const s of outcome.sources) {
      for (const m of catalog) if (givesSource(m, s) && !could.some((x) => x.connectorId === m.id)) could.push({ connectorId: m.id, name: m.name, href: connectHref(m.id), siteOnly: s.siteOnly });
    }
    return { kind, state: "not_connected", could };
  });
}

/** "A", "A or B", "A, B or C". */
const orList = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/**
 * The "What we can measure" line's words, one per kind. Client safe; the help page quotes them
 * (src/components/help/pages/brand-map.tsx, #strategy). House style: no dashes as punctuation.
 */
export const OUTCOME_WORDS = {
  lead: "What we can measure:",
  /** Nothing is connected or shared yet. */
  builtInOnly: "From your brand map and articles only.",
  measured: (c: Extract<KindCoverage, { state: "measured" }>) => `${OUTCOMES[c.kind].label} (${c.connector}${c.siteOnly ? ", whole site only" : ""})`,
  missing(c: Exclude<KindCoverage, { state: "measured" }>): string {
    const o = OUTCOMES[c.kind];
    if (c.state === "not_shared") return `Share ${c.connector} with your team and Vizzy to see ${o.tells}.`;
    if (c.state === "failed") return `${c.connector} couldn't be read. Check its connection to see ${o.tells}.`;
    const perPage = c.could.filter((x) => !x.siteOnly).map((x) => x.name);
    if (perPage.length) return `Connect ${orList(perPage)} to see ${o.tells}.`;
    const site = c.could.map((x) => x.name);
    return site.length ? `Connect ${orList(site)} to see ${o.noun} for your whole site.` : `Nothing in this copy of YouGrow measures ${o.noun} yet.`;
  },
} as const;
