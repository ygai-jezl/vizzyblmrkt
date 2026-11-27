import { describe, expect, it } from "vitest";
import { allConnectors } from "@/lib/connectors/catalog";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { ConnectionGrant } from "@/lib/types/dataConnection";
import { MEANINGS } from "./meanings";
import { OUTCOME_KINDS, OUTCOME_WORDS, OUTCOMES, connectHref, givesSource, outcomeCoverage, type CoverageConnection, type KindCoverage } from "./outcomes";

// The kinds of result and what measures each, from every connector this build knows. Connections
// are made up; no provider is called.
const CATALOG = allConnectors();
const SHARED: ConnectionGrant[] = [
  { to: "members", can: "read" },
  { to: "agent:vizzy", can: "read" },
];
let n = 0;
const conn = (connectorId: string, over: Partial<CoverageConnection> = {}): CoverageConnection => ({
  id: `dcn_${String(++n).padStart(20, "a")}`,
  connectorId,
  status: "connected",
  account: "example.com",
  grants: SHARED,
  createdAt: `2026-10-0${Math.min(9, n)}T10:00:00.000Z`,
  health: { state: "ok" },
  ...over,
});
const of = (list: KindCoverage[], kind: string) => list.find((c) => c.kind === kind)!;

describe("the kinds of result", () => {
  it("names numbers that exist, and each kind has at least one connector in this build that can give it", () => {
    for (const kind of OUTCOME_KINDS) {
      const o = OUTCOMES[kind];
      for (const s of o.sources) for (const k of s.measures) expect(Object.keys(MEANINGS), k).toContain(k);
      expect(o.sources.some((s) => CATALOG.some((m) => givesSource(m, s))), kind).toBe(true);
    }
  });

  it("measures visits by an article's own sessions first, and Cloudflare's whole site visits only as a site total", () => {
    expect(OUTCOMES.visits.sources.map((s) => [s.measures[0], s.siteOnly])).toEqual([
      ["ga4Sessions", false],
      ["cfVisits", true],
    ]);
  });

  it("keeps its words to house style", () => {
    const lines = [
      ...OUTCOME_KINDS.flatMap((k) => [OUTCOMES[k].label, OUTCOMES[k].column, OUTCOMES[k].tells, OUTCOMES[k].noun]),
      OUTCOME_WORDS.lead,
      OUTCOME_WORDS.builtInOnly,
      ...outcomeCoverage([], CATALOG).map((c) => (c.state === "measured" ? OUTCOME_WORDS.measured(c) : OUTCOME_WORDS.missing(c))),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});

describe("outcomeCoverage", () => {
  it("with no connections, says for each kind what this build could connect, each linked to its Connect page", () => {
    const c = outcomeCoverage([], CATALOG);
    expect(c.map((x) => [x.kind, x.state])).toEqual(OUTCOME_KINDS.map((k) => [k, "not_connected"]));
    expect(of(c, "search")).toEqual({ kind: "search", state: "not_connected", could: [{ connectorId: "search-console", name: "Google Search Console", href: "/admin/account/connections/search-console", siteOnly: false }] });
    expect(of(c, "visits")).toMatchObject({
      could: [
        { connectorId: "google-analytics", siteOnly: false },
        { connectorId: "cloudflare", siteOnly: true, href: connectHref("cloudflare") },
      ],
    });
    expect(OUTCOME_WORDS.missing(of(c, "key_actions") as Exclude<KindCoverage, { state: "measured" }>)).toBe("Connect Google Analytics 4 to see which focus situations bring sign-ups.");
    expect(OUTCOME_WORDS.missing(of(c, "visits") as Exclude<KindCoverage, { state: "measured" }>)).toBe("Connect Google Analytics 4 to see which focus situations bring visits.");
  });

  it("offers only the connectors this build offers", () => {
    const c = outcomeCoverage([], CATALOG.filter((m) => m.id === "cloudflare"));
    expect(of(c, "visits")).toMatchObject({ state: "not_connected", could: [{ connectorId: "cloudflare", siteOnly: true }] });
    expect(OUTCOME_WORDS.missing(of(c, "visits") as Exclude<KindCoverage, { state: "measured" }>)).toBe("Connect Cloudflare to see visits for your whole site.");
    expect(of(c, "search")).toEqual({ kind: "search", state: "not_connected", could: [] });
    expect(OUTCOME_WORDS.missing(of(c, "search") as Exclude<KindCoverage, { state: "measured" }>)).toBe("Nothing in this copy of YouGrow measures clicks from search yet.");
    // A connection to a connector that isn't offered counts for nothing.
    expect(of(outcomeCoverage([conn("search-console")], CATALOG.filter((m) => m.id === "cloudflare")), "search").state).toBe("not_connected");
  });

  it("with one connection, measures what it gives and nothing else", () => {
    const sc = conn("search-console");
    const c = outcomeCoverage([sc], CATALOG);
    expect(of(c, "search")).toEqual({ kind: "search", state: "measured", connectionId: sc.id, connectorId: "search-console", connector: "Google Search Console", measure: "searchClicks", siteOnly: false, alsoConnected: [] });
    expect(of(c, "visits").state).toBe("not_connected");
    expect(OUTCOME_WORDS.measured(of(c, "search") as Extract<KindCoverage, { state: "measured" }>)).toBe("Found in search (Google Search Console)");
  });

  it("with several for one kind, takes the first by order of meanings, then the one matching the most article pages, and lists the rest", () => {
    const cf = conn("cloudflare", { createdAt: "2026-01-01T00:00:00.000Z" });
    const ga1 = conn("google-analytics", { createdAt: "2026-02-01T00:00:00.000Z" });
    const ga2 = conn("google-analytics", { createdAt: "2026-03-01T00:00:00.000Z" });
    // Sessions come before Cloudflare's visits, however old the Cloudflare connection is.
    const first = of(outcomeCoverage([cf, ga1, ga2], CATALOG), "visits");
    expect(first).toMatchObject({ state: "measured", connectionId: ga1.id, measure: "ga4Sessions", siteOnly: false });
    expect(first.state === "measured" && first.alsoConnected.map((x) => x.connectionId)).toEqual([ga2.id, cf.id]);
    // The newer property matched more of the brand's articles: it is the one read.
    const busier = of(outcomeCoverage([cf, ga1, ga2], CATALOG, { matched: { [ga1.id]: 2, [ga2.id]: 9 } }), "visits");
    expect(busier).toMatchObject({ connectionId: ga2.id });
    // Only Cloudflare: a site total.
    const site = of(outcomeCoverage([cf], CATALOG), "visits");
    expect(site).toMatchObject({ state: "measured", connectionId: cf.id, measure: "cfVisits", siteOnly: true });
    expect(OUTCOME_WORDS.measured(site as Extract<KindCoverage, { state: "measured" }>)).toBe("Visits (Cloudflare, whole site only)");
    // Key actions come only from Analytics.
    expect(of(outcomeCoverage([cf], CATALOG), "key_actions").state).toBe("not_connected");
  });

  it("says when a connection isn't shared with the team and Vizzy, linking to it", () => {
    const ga = conn("google-analytics", { grants: [{ to: "members", can: "read" }] });
    const c = of(outcomeCoverage([ga], CATALOG), "key_actions");
    expect(c).toEqual({ kind: "key_actions", state: "not_shared", connectionId: ga.id, connectorId: "google-analytics", connector: "Google Analytics 4", href: `/admin/account/connections/connected?c=${ga.id}` });
    expect(OUTCOME_WORDS.missing(c as Exclude<KindCoverage, { state: "measured" }>)).toBe("Share Google Analytics 4 with your team and Vizzy to see which focus situations bring sign-ups.");
    // A shared Cloudflare still measures visits, for the whole site.
    expect(of(outcomeCoverage([ga, conn("cloudflare")], CATALOG), "visits")).toMatchObject({ state: "measured", connectorId: "cloudflare" });
  });

  it("says when the read failed or the connection is broken, and falls to the next source that works", () => {
    const vz = conn("vizzybl");
    const failed = of(outcomeCoverage([vz], CATALOG, { failed: [vz.id] }), "ai_answers");
    expect(failed).toMatchObject({ state: "failed", connectionId: vz.id, connector: "Vizzybl", href: `/admin/account/connections/connected?c=${vz.id}` });
    expect(of(outcomeCoverage([{ ...vz, health: { state: "broken" } }], CATALOG), "ai_answers").state).toBe("failed");
    const ga = conn("google-analytics");
    const cf = conn("cloudflare");
    expect(of(outcomeCoverage([ga, cf], CATALOG, { failed: [ga.id] }), "visits")).toMatchObject({ state: "measured", connectionId: cf.id, siteOnly: true });
  });

  it("leaves out connections that aren't connected or have no account yet", () => {
    const c = outcomeCoverage([conn("search-console", { status: "disconnected" }), conn("search-console", { account: "" })], CATALOG);
    expect(of(c, "search").state).toBe("not_connected");
  });
});
