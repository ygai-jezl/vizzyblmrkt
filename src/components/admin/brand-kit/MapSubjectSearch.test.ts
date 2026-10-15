import { describe, expect, it } from "vitest";
import { matchSubjects } from "./MapSubjectSearch";

const NAMES = [
  { id: "a", name: "AI share of voice" },
  { id: "b", name: "Share of voice" },
  { id: "c", name: "Citation gaps" },
  { id: "d", name: "Competitors in AI answers" },
];

describe("finding a subject by typing", () => {
  it("matches every word typed, names that start with it first, then the shorter", () => {
    expect(matchSubjects(NAMES, "share voice").map((s) => s.id)).toEqual(["b", "a"]);
    expect(matchSubjects(NAMES, "ai").map((s) => s.id)).toEqual(["a", "d"]);
    expect(matchSubjects(NAMES, "nothing like it")).toEqual([]);
  });

  it("lists the first few with nothing typed, and never more than asked for", () => {
    expect(matchSubjects(NAMES, "  ")).toHaveLength(4);
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, name: `Subject ${i}` }));
    expect(matchSubjects(many, "subject 49")).toHaveLength(12);
  });
});
