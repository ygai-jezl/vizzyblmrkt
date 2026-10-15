import { describe, expect, it, vi } from "vitest";
import { lookupName } from "./lookup";

// Made-up items: the ids are Wikidata-shaped but stand for nothing real.
const SEARCH = { search: [{ id: "Q1001" }, { id: "Q1002" }, { id: "Q1003" }, { id: "not-an-id" }] };
const ENTITIES = {
  entities: {
    Q1001: {
      labels: { mul: { value: "Acme" } }, // a name kept under `mul` only, as Wikidata now does for many
      descriptions: { en: { value: "software company" } },
      aliases: {},
      sitelinks: { enwiki: { url: "https://en.wikipedia.org/wiki/Acme_(company)" } },
    },
    Q1002: {
      labels: { en: { value: "Acme Corporation" } },
      descriptions: { en: { value: "fictional company" } },
      aliases: { en: [{ value: "ACME" }] },
      sitelinks: {},
    },
    Q1003: { labels: { en: { value: "Acme" } }, descriptions: { en: { value: "Wikimedia disambiguation page" } }, aliases: {}, sitelinks: {} },
  },
};
const CLAIMS: Record<string, unknown> = {
  Q1001: { claims: { P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.acme.example/" } } }] } },
  Q1002: { claims: { P856: [{ rank: "deprecated", mainsnak: { datavalue: { value: "https://old.example/" } } }] } },
};

const fetchJson = vi.fn(async (url: string) => {
  const q = new URL(url).searchParams;
  if (q.get("action") === "wbsearchentities") return SEARCH;
  if (q.get("action") === "wbgetentities") return ENTITIES;
  if (q.get("action") === "wbgetclaims") return CLAIMS[q.get("entity") ?? ""] ?? { claims: {} };
  return null;
});

describe("identifier lookups", () => {
  it("finds candidates, says which match the name, and drops disambiguation pages", async () => {
    const r = await lookupName("acme", { kind: "alternative" }, { fetchJson });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => [c.id, c.matched, c.looksLikeYou])).toEqual([
      ["Q1001", true, false],
      ["Q1002", true, false], // by its alias
    ]);
    expect(r.candidates[0]).toMatchObject({
      label: "Acme",
      wikidataUrl: "https://www.wikidata.org/wiki/Q1001",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Acme_(company)",
      officialSites: ["https://www.acme.example/"],
    });
    // A deprecated official website is not shown.
    expect(r.candidates[1]!.officialSites).toEqual([]);
    // Only the name was sent: every request is to Wikidata's API.
    expect(fetchJson.mock.calls.every(([u]) => String(u).startsWith("https://www.wikidata.org/w/api.php?"))).toBe(true);
  });

  it("says “this looks like you” only for the brand itself, on its own domain", async () => {
    const brand = await lookupName("Acme", { kind: "brand", ownSites: ["acme.example"] }, { fetchJson });
    expect(brand.ok && brand.candidates[0]!.looksLikeYou).toBe(true);
    const other = await lookupName("Acme", { kind: "alternative", ownSites: ["acme.example"] }, { fetchJson });
    expect(other.ok && other.candidates.some((c) => c.looksLikeYou)).toBe(false);
  });

  it("is unavailable when Wikidata does not answer, and empty when it has nothing", async () => {
    expect(await lookupName("Acme", { kind: "category" }, { fetchJson: async () => null })).toEqual({ ok: false, error: "lookup_unavailable" });
    expect(await lookupName("Acme", { kind: "category" }, { fetchJson: async () => ({ search: [] }) })).toEqual({ ok: true, candidates: [] });
    expect(await lookupName("   ", { kind: "category" }, { fetchJson })).toEqual({ ok: false, error: "invalid_input" });
  });
});
