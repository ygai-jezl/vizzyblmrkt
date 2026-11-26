import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { PLAN_ERRORS, hubLine, madeNote } from "./contentPlanMessages";

describe("what the Content plan says", () => {
  it("names a pillar's hub the way Vizzy does, a planned one included", () => {
    expect(hubLine({ hub: null })).toBe("hub: none yet");
    expect(hubLine({ hub: { kind: "home", url: "https://a.example.com/guide" } })).toBe("hub: your page");
    expect(hubLine({ hub: { kind: "slot", title: "AI visibility tracking, explained", live: true } })).toBe("hub: AI visibility tracking, explained");
    expect(hubLine({ hub: { kind: "slot", title: "AI visibility tracking, explained", live: false } })).toBe("hub to write first: AI visibility tracking, explained");
  });

  it("keeps to house style", () => {
    const all = [...Object.values(PLAN_ERRORS), madeNote({ lookupsAsked: 2, byMeaning: false, leftOut: 3 })].join("\n");
    expect(dashesIn(all)).toEqual([]);
    expect(aiTellsIn(all)).toEqual([]);
  });
});
