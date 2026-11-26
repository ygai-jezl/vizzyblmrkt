import { describe, expect, it } from "vitest";
import { StrategySchema, emptyStrategy, groupsOf, type StrategyCompetitor, type CompetitorGroupKind } from "@/lib/types/brandStrategy";
import { approvedCopy, liveCompetitors, suggestionsOf } from "./competitors";

// Made-up competitors.
const entry = (name: string, over: Partial<StrategyCompetitor & { group: CompetitorGroupKind }> = {}) => ({
  name,
  site: `${name.toLowerCase().replace(/\s+/g, "")}.example`,
  foundTimes: 1,
  evidence: [],
  ticked: false,
  from: "finder" as const,
  group: "most" as CompetitorGroupKind,
  ...over,
});
const draftOf = (...list: Array<ReturnType<typeof entry>>) => StrategySchema.parse({ ...emptyStrategy("", null), competitorGroups: groupsOf(list) });
const watch = (id: string, name: string, site: string, group?: CompetitorGroupKind | null) => ({ id, name, site, ...(group !== undefined ? { group } : {}) });

describe("the live competitor list", () => {
  it("lists every watched competitor first, before any Propose too, not grouped until a person groups it", () => {
    const list = liveCompetitors(null, [watch("cmp_aaaaaaaa01", "Rivalco", "rivalco.example"), watch("cmp_aaaaaaaa02", "Brightline", "brightline.example", "big")], []);
    expect(list.map((c) => [c.name, c.id, c.group, c.monitored])).toEqual([
      ["Rivalco", "cmp_aaaaaaaa01", null, true],
      ["Brightline", "cmp_aaaaaaaa02", "big", true],
    ]);
  });

  it("shows the group on the competitor's record, an older draft's only as a hint, and matches by site or folded name", () => {
    const draft = draftOf(entry("Rivalco", { from: "watched", ticked: true, group: "one_job" }), entry("BRIGHT LINE", { site: null, foundTimes: 3, group: "instead" }), entry("Other"));
    const list = liveCompetitors(draft, [watch("cmp_aaaaaaaa01", "Rivalco Inc", "rivalco.example"), watch("cmp_aaaaaaaa02", "Bright Line", "brightline.example", "most")], []);
    expect(list.map((c) => [c.name, c.group, c.was, c.from, c.foundTimes])).toEqual([
      // By site: no group on its record, so not grouped; the older draft's group is a hint.
      ["Rivalco Inc", null, "one_job", "watched", 1],
      // By folded name: the record's group, no hint, and the finder's count stays.
      ["Bright Line", "most", null, "finder", 3],
      // Not watched: a suggestion, in the finder's group.
      ["Other", "most", null, "finder", 1],
    ]);
    expect(suggestionsOf(list).map((c) => c.name)).toEqual(["Other"]);
  });

  it("drops an entry copied in as watched once it isn't, and every name marked Not a competitor", () => {
    const draft = draftOf(entry("Gone", { from: "watched", ticked: true }), entry("Nope"), entry("Renamed", { site: "kept.example" }), entry("Still"));
    const list = liveCompetitors(draft, [], [{ name: "nope", site: null }, { name: "Different name", site: "kept.example" }]);
    expect(list.map((c) => c.name)).toEqual(["Still"]);
    // Watched wins over Not a competitor: a person who watches it later sees it.
    expect(liveCompetitors(draft, [watch("cmp_aaaaaaaa03", "Nope", "nope.example")], [{ name: "Nope", site: null }]).map((c) => `${c.name}:${c.monitored}`)).toContain("Nope:true");
  });

  it("drops a suggestion a person monitored from here once they stop watching it, and shows it while watched", () => {
    const draft = draftOf(entry("Alpha"), entry("Beta"));
    const monitored = [{ name: "Alpha", site: "alpha.example" }];
    expect(liveCompetitors(draft, [], [], monitored).map((c) => c.name)).toEqual(["Beta"]);
    expect(liveCompetitors(draft, [watch("cmp_aaaaaaaa01", "Alpha", "alpha.example")], [], monitored).map((c) => `${c.name}:${c.monitored}`)).toEqual(["Alpha:true", "Beta:false"]);
  });

  it("shows the draft as it is, with its ticks, for a brand that can't read its competitors", () => {
    const draft = draftOf(entry("Ticked", { ticked: true }), entry("Copied", { from: "watched", ticked: true }), entry("Left"));
    const list = liveCompetitors(draft, null, [{ name: "Left", site: null }]);
    expect(list.map((c) => [c.name, c.ticked, c.monitored, c.id])).toEqual([
      ["Ticked", true, false, null],
      ["Copied", true, false, null],
    ]);
  });

  it("keeps the whole list as approval copies it: grouped ones in their groups, and the watched ones nobody grouped", () => {
    const draft = draftOf(entry("Found"), entry("Rivalco", { group: "big" }));
    const copy = approvedCopy(liveCompetitors(draft, [watch("cmp_aaaaaaaa01", "Rivalco", "rivalco.example"), watch("cmp_aaaaaaaa02", "Newco", "newco.example")], []));
    // Rivalco's record has no group: the draft's "big" is only a hint, so it is kept ungrouped.
    expect(copy.competitorGroups.map((g) => [g.kind, g.competitors.map((c) => `${c.name}:${c.ticked}`)])).toEqual([["most", ["Found:false"]]]);
    expect(copy.ungrouped.map((c) => c.name)).toEqual(["Rivalco", "Newco"]);
    const grouped = approvedCopy(liveCompetitors(draft, [watch("cmp_aaaaaaaa01", "Rivalco", "rivalco.example", "big")], []));
    expect(grouped.competitorGroups.map((g) => [g.kind, g.competitors.map((c) => c.name)])).toEqual([
      ["most", ["Found"]],
      ["big", ["Rivalco"]],
    ]);
    // Plain strategy competitors: no id, group or monitored on the stored copy.
    expect(Object.keys(copy.ungrouped[0]!).sort()).toEqual(["evidence", "foundTimes", "from", "name", "site", "ticked"]);
  });
});
