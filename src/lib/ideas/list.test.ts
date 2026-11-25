import { describe, expect, it } from "vitest";
import { ideaFilterCounts, ideaFilterOf, parseIdeaFilter } from "./list";

describe("the launches list's status filter", () => {
  it("puts a launch nobody gave a status under none, never Exploring", () => {
    expect(ideaFilterOf({})).toBe("none");
    expect(ideaFilterOf({ idea: { hypothesis: "Teams pay." } })).toBe("none");
    expect(ideaFilterOf({ idea: { status: "testing" } })).toBe("testing");
  });

  it("puts Just a list first, whatever status it had", () => {
    expect(ideaFilterOf({ idea: { status: "parked", justAList: true } })).toBe("list");
    expect(ideaFilterOf({ idea: { status: "parked", justAList: false } })).toBe("parked");
  });

  it("reads only a status, none or list from the query", () => {
    expect(parseIdeaFilter("validated")).toBe("validated");
    expect(parseIdeaFilter("none")).toBe("none");
    expect(parseIdeaFilter("list")).toBe("list");
    for (const raw of [undefined, "", "archived", "Testing", ["testing"]]) expect(parseIdeaFilter(raw)).toBeNull();
  });

  it("counts every part of the filter, zeros included", () => {
    const counts = ideaFilterCounts([{ idea: { status: "testing" } }, { idea: { status: "testing" } }, {}, { idea: { justAList: true } }]);
    expect(counts).toEqual({ exploring: 0, testing: 2, validated: 0, launched: 0, parked: 0, killed: 0, none: 1, list: 1 });
  });
});
