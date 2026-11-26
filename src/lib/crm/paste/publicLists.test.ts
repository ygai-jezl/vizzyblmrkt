import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { ALL_PUBLIC_LIST_STRINGS, KIT_URL, PUBLIC_LIST } from "./publicLists";
import { PASTE_NOTES } from "./words";

describe("Start from a public list", () => {
  it("links to the kit's original page exactly, and credits both of its makers", () => {
    expect(KIT_URL).toBe("https://notion.notion.site/The-AI-Fundraising-Kit-281efdeead058156bd19e58435c270aa");
    expect(PUBLIC_LIST.kit).toEqual({ label: "Open the original", url: KIT_URL });
    expect(PUBLIC_LIST.credit).toBe("The AI Fundraising Kit, made by The VC Corner with Notion.");
    expect(PUBLIC_LIST.credit).toContain("The VC Corner");
    expect(PUBLIC_LIST.credit).toContain("Notion");
  });

  it("says the kit is never copied, and what a firm row loses, in the sheet's own words", () => {
    expect(PUBLIC_LIST.footnote).toBe("YouGrow doesn't copy the kit. You keep only the rows you add.");
    expect(PUBLIC_LIST.firms).toBe(PASTE_NOTES.firms_left_out);
  });

  it("links out only over https, to the three directories", () => {
    expect(PUBLIC_LIST.others.map((o) => o.label)).toEqual(["OpenVC", "Signal by NFX", "Visible Connect"]);
    for (const o of [PUBLIC_LIST.kit, ...PUBLIC_LIST.others]) expect(o.url).toMatch(/^https:\/\//);
  });

  it("keeps to house style: no dashes as punctuation and no AI tells", () => {
    for (const s of ALL_PUBLIC_LIST_STRINGS) expect([...dashesIn(s), ...aiTellsIn(s)], s).toEqual([]);
    expect(PUBLIC_LIST.guidance).toEqual(["Ten good fits beat a hundred names.", "Lists go out of date. Check the fund's own site before you write.", "You found them, so tell them where."]);
  });
});
