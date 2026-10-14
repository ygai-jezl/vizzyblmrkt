import { describe, expect, it } from "vitest";
import type { BlogEntity } from "@/lib/types/contentPlan";
import type { ArticleMap } from "./articleMap";
import { avoidedUses, canonicaliseEntities, indexNames, mentionsName, notOnMap, ownSentences } from "./names";

const MAP: Pick<ArticleMap, "identity" | "names"> = {
  identity: {
    name: "Acme",
    category: "AI visibility tracking",
    statement: "",
    isNot: [],
    avoid: [{ term: "GEO tool", useInstead: "AI visibility tracking" }],
    site: "",
    profiles: [],
    categorySameAs: [],
  },
  names: [
    { id: "n_1", name: "Acme Pulse", kind: "product", aliases: ["Pulse", "Flow"], home: null, sameAs: [] },
    { id: "n_2", name: "Rivalco", kind: "alternative", aliases: ["Rivalco Inc", "Flow"], home: null, sameAs: [] },
    { id: "n_3", name: "Google Analytics 4", kind: "integration", aliases: ["GA4"], home: null, sameAs: [] },
  ],
};
const e = (name: string, relation: BlogEntity["relation"], by: BlogEntity["by"] = "research"): BlogEntity => ({ name, relation, by });

describe("matching an article's names to the brand map", () => {
  it("spells research's names the map's way, brand and category first", () => {
    const r = canonicaliseEntities(
      [
        e("ACME", "brand"),
        e("GEO software", "category"),
        e("rivalco inc", "alternative"),
        e("Pulse", "product"),
        e("GA4", "integration"),
        e("Peec", "alternative"),
        e("Workflow", "use_case"),
      ],
      indexNames(MAP),
      16,
    );
    expect(r.entities).toEqual([
      e("Acme", "brand"),
      e("AI visibility tracking", "category"),
      e("Rivalco", "alternative"),
      e("Acme Pulse", "product"),
      e("Google Analytics 4", "integration"),
      e("Peec", "alternative"),
      e("Workflow", "use_case"),
    ]);
    expect(r.unknown.map((x) => x.name)).toEqual(["Peec", "Workflow"]);
    expect(r.respelled).toEqual([
      { from: "GEO software", to: "AI visibility tracking" },
      { from: "rivalco inc", to: "Rivalco" },
      { from: "Pulse", to: "Acme Pulse" },
      { from: "GA4", to: "Google Analytics 4" },
    ]);
  });

  it("matches neither name for a spelling two of them share, and an alias only when the kind fits", () => {
    const r = canonicaliseEntities([e("Flow", "product"), e("Pulse", "alternative")], indexNames(MAP), 16);
    expect(r.entities.slice(2)).toEqual([e("Flow", "product"), e("Pulse", "alternative")]);
    expect(r.unknown).toHaveLength(2);
  });

  it("never renames a person's own rows, and is idempotent", () => {
    const once = canonicaliseEntities([e("Pulse", "product", "operator"), e("rivalco", "alternative")], indexNames(MAP), 16);
    expect(once.entities).toContainEqual(e("Pulse", "product", "operator"));
    const twice = canonicaliseEntities(once.entities, indexNames(MAP), 16);
    expect(twice.entities).toEqual(once.entities);
  });

  it("marks the names the map does not have, a person's own included", () => {
    const rows = [e("Acme", "brand"), e("Pulse", "product", "operator"), e("Peec", "alternative"), e("Notion", "integration", "operator"), e("Flow", "product")];
    expect(rows.filter(notOnMap(MAP, rows)).map((r) => r.name)).toEqual(["Peec", "Notion", "Flow"]);
  });

  it("knows a whole name from part of a word", () => {
    expect(mentionsName("Teams use Acme Pulse daily.", "Acme Pulse")).toBe(true);
    expect(mentionsName("A workflow tool.", "Flow")).toBe(false);
    expect(mentionsName("Buy a notion of it.", "Notion")).toBe(false);
    expect(mentionsName("Rivalco's plans", "Rivalco")).toBe(true);
    expect(mentionsName("用于 AI 搜索可见性的工具", "搜索可见性")).toBe(true);
  });

  it("reads only the article's own sentences for names it avoids", () => {
    const md = [
      "# Is Acme a GEO tool?",
      "",
      "Acme is not a GEO tool in the usual sense. Most GEO tools rank pages.",
      "",
      "> \"We were looking for a GEO tool\" — a buyer",
      "",
      "Acme does AI visibility tracking, which some call a GEO tool.",
      "",
      "See [the GEO tool guide](https://example.org/geo-tool).",
      "",
      "```",
      "geo tool",
      "```",
      "",
      "## Sources",
      "",
      "1. [GEO tool survey](https://example.org/survey) — Example, 2026",
    ].join("\n");
    expect(ownSentences(md)).toEqual([
      "Acme is not a GEO tool in the usual sense.",
      "Most GEO tools rank pages.",
      "Acme does AI visibility tracking, which some call a GEO tool.",
      "See .",
    ]);
    expect(avoidedUses(md, MAP.identity.avoid)).toEqual([{ term: "GEO tool", useInstead: "AI visibility tracking", count: 2 }]);
  });
});
