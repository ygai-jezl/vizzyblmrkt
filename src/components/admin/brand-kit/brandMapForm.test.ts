import { describe, expect, it } from "vitest";
import { BrandMapDecidedSchema, BrandMapSuggestionSchema, type BrandMapSuggestion } from "@/lib/types/brandMap";
import { changeKey } from "@/lib/brandMap/changes";
import { decidedOf, firstRunFill, groupNames, isBlank, isDirty, issuesAt, splitList } from "./brandMapForm";

const suggestion = (change: Record<string, unknown>, over: Partial<BrandMapSuggestion> = {}): BrandMapSuggestion => {
  const parsed = BrandMapSuggestionSchema.parse({ id: "sg_aaaaaaaa", key: "k", change, from: "research", at: "t", ...over });
  return { ...parsed, key: changeKey(parsed.change) };
};

describe("the Brand map editor's helpers", () => {
  it("fills a blank map from research for one save, leaving the inferred lines to check", () => {
    const rows = [
      suggestion({ type: "set_identity", field: "category", value: "AI visibility tracking" }),
      suggestion({ type: "add_subject", name: "Share of voice" }),
      suggestion({ type: "add_question", subject: "Share of voice", text: "What is it?" }),
      suggestion({ type: "add_avoid", term: "GEO tool", useInstead: "AI visibility tracking" }, { inferred: true }),
      suggestion({ type: "add_name", name: "Peec", kind: "alternative" }, { from: "vizzy" }),
    ];
    const fill = firstRunFill(decidedOf(null), rows);
    expect(fill.decided.identity.category).toBe("AI visibility tracking");
    expect(fill.decided.subjects[0]?.questions[0]?.text).toBe("What is it?");
    expect(fill.decided.identity.avoid).toEqual([]);
    expect(fill.accepted).toEqual(["identity:category:ai visibility tracking", "subject:share of voice", "q:share of voice:what is it"]);
    expect(fill.waiting.map((s) => s.key)).toEqual(["avoid:geo tool", "name:peec"]);
  });

  it("is not dirty over a link's confirmation date alone", () => {
    const a = BrandMapDecidedSchema.parse({ identity: { profiles: [{ url: "https://x.example/acme", confirmedAt: "2026-01-01" }] } });
    const b = BrandMapDecidedSchema.parse({ identity: { profiles: [{ url: "https://x.example/acme", confirmedAt: "" }] } });
    expect(isDirty(a, b)).toBe(false);
    expect(isDirty(a, BrandMapDecidedSchema.parse({}))).toBe(true);
    expect(isBlank(decidedOf(null))).toBe(true);
  });

  it("finds the issues under a field", () => {
    const issues = [
      { path: "names.3.home", message: "must be a page on your own site" },
      { path: "names.30.name", message: "taken" },
    ];
    expect(issuesAt(issues, "names.3")).toEqual(["must be a page on your own site"]);
  });

  it("groups names by what they are, keeping each one's place", () => {
    const d = BrandMapDecidedSchema.parse({
      names: [
        { id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" },
        { id: "n_bbbbbbbb", name: "Pulse", kind: "product" },
      ],
    });
    const groups = groupNames(d.names).filter((g) => g.rows.length);
    expect(groups.map((g) => [g.kind, g.rows.map((r) => r.index)])).toEqual([
      ["product", [1]],
      ["alternative", [0]],
    ]);
  });

  it("reads a typed list once each", () => {
    expect(splitList(" Rivalco Inc,  rivalco inc , ,Rival  Co", 6)).toEqual(["Rivalco Inc", "rivalco inc", "Rival Co"]);
  });
});
