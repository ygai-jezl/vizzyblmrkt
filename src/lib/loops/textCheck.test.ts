import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { NOTE_REFUSED_MESSAGE, textRefusalOf } from "./textCheck";

/** The one check on words a person gives the loops (3.4 and 3.11 of the plan for steps 4 and 5). */
describe("the loops' text check", () => {
  it("keeps the words a team writes about its images", () => {
    for (const ok of [
      "too dark for a bakery window",
      "Overhead daylight, flour on dark wood. Loaves close up.",
      "dark wood.It needs more light",
      "like the 2020-2024 range, 1200 x 1200 crops",
      "Maya liked the 3 loaves at 9 am",
      "e.g. warmer colours, less blue",
    ]) {
      expect(textRefusalOf(ok), ok).toBeNull();
    }
  });

  it("refuses a link, an email address, a handle or a phone number", () => {
    expect(textRefusalOf("see https://hearth.example/menu")).toBe("link");
    expect(textRefusalOf("like www.lumen.test")).toBe("link");
    expect(textRefusalOf("copy hearthbakery.com/loaves")).toBe("link");
    expect(textRefusalOf("ask maya@example.com first")).toBe("email");
    expect(textRefusalOf("more like @hearthbakery")).toBe("handle");
    expect(textRefusalOf("call 020 7946 0958")).toBe("phone");
    expect(textRefusalOf("call +44 (0)20 7946-0958")).toBe("phone");
  });

  it("says so in house style", () => {
    expect(dashesIn(NOTE_REFUSED_MESSAGE)).toEqual([]);
    expect(aiTellsIn(NOTE_REFUSED_MESSAGE)).toEqual([]);
  });
});
