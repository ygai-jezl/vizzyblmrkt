import { describe, expect, it } from "vitest";
import { KIND_GROUPS, shownGroups } from "./labels";

describe("the Search card's groups", () => {
  it("leave out Decks while the Raise kit is off, so the card looks as it did before", () => {
    const off = shownGroups({ decks: false }).map((g) => g.label);
    expect(off).not.toContain("Decks");
    expect(off).toEqual(KIND_GROUPS.filter((g) => g.key !== "decks").map((g) => g.label));
  });

  it("show Decks last while it is on", () => {
    expect(shownGroups({ decks: true }).map((g) => g.label).at(-1)).toBe("Decks");
    expect(shownGroups({ decks: true })).toHaveLength(KIND_GROUPS.length);
  });
});
