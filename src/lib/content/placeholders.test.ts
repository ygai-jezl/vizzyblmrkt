import { describe, it, expect } from "vitest";
import { bodyTokens, reconcilePlaceholders, orphanPlaceholders } from "./placeholders";

describe("placeholders", () => {
  it("extracts distinct tokens in order", () => {
    expect(bodyTokens("a {{One}} b {{Two}} c {{One}}")).toEqual(["One", "Two"]);
    expect(bodyTokens("no tokens")).toEqual([]);
  });

  it("reconciles to the body — adds missing, drops orphans, merges metadata", () => {
    const out = reconcilePlaceholders("{{A}} and {{B}}", [
      { token: "A", label: "Alpha", kind: "word" },
      { token: "Z", label: "ghost" }, // orphan, not in body → dropped
    ]);
    const tokens = out.map((p) => p.token).sort();
    expect(tokens).toEqual(["A", "B"]);
    expect(out.find((p) => p.token === "A")?.label).toBe("Alpha");
    // B was missing from the model list → derived
    expect(out.find((p) => p.token === "B")?.label).toBeTruthy();
  });

  it("marks repeatable when a token recurs", () => {
    const out = reconcilePlaceholders("- {{Item}}\n- {{Item}}\n- {{Item}}", []);
    expect(out).toHaveLength(1);
    expect(out[0]?.repeatable).toBe(true);
  });

  it("infers a humanized label + kind for un-described tokens", () => {
    const out = reconcilePlaceholders("{{WinningOutcome}}", []);
    expect(out[0]?.label).toBe("Winning Outcome");
  });

  it("ignores an over-length token (>60 chars) so it can't violate the schema", () => {
    const long = "A".repeat(70);
    expect(bodyTokens(`{{${long}}} and {{Ok}}`)).toEqual(["Ok"]);
    const out = reconcilePlaceholders(`{{${long}}} and {{Ok}}`, []);
    expect(out.map((p) => p.token)).toEqual(["Ok"]);
    expect(out.every((p) => p.token.length <= 60)).toBe(true);
  });

  it("reports orphan tokens (model tokens absent from the body)", () => {
    expect(orphanPlaceholders("{{A}}", [{ token: "A" }, { token: "B" }])).toEqual(["B"]);
    expect(orphanPlaceholders("{{A}}", [{ token: "A" }])).toEqual([]);
  });
});
