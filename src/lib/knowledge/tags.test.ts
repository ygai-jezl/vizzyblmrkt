import { describe, it, expect } from "vitest";
import { normalizeTags } from "./tags";

describe("normalizeTags", () => {
  it("trims, lowercases, collapses whitespace, dedupes, drops empties", () => {
    expect(normalizeTags(["  Foo ", "foo", "BAR", "", "  ", "a   b"])).toEqual([
      "foo",
      "bar",
      "a b",
    ]);
  });

  it("ignores non-arrays and non-string entries", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags("x")).toEqual([]);
    expect(normalizeTags([1, "ok", {}, true])).toEqual(["ok"]);
  });

  it("caps at 20 tags and 40 chars each", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(20);
    expect(normalizeTags(["x".repeat(60)])[0]!).toHaveLength(40);
  });
});
