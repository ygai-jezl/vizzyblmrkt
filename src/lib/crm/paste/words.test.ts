import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  addedWords,
  addWords,
  agentSummary,
  ALL_PASTE_STRINGS,
  alreadyAtAdd,
  batchCountWords,
  companyPastedLine,
  fromReview,
  pasteErrorText,
  personPastedLine,
  readSummary,
  reviewDetail,
  timelineDetail,
} from "./words";

describe("paste words", () => {
  it("keep to house style: no dashes as punctuation and no AI tells", () => {
    const made = [
      readSummary(13, 10, 3, 1),
      agentSummary(13, 10, 3, 1),
      addedWords({ people: 10, companies: 3 }),
      alreadyAtAdd(2),
      fromReview(3),
      reviewDetail({ people: 10, companies: 3 }, "A friend's sheet"),
      personPastedLine("Jo Example", "26 Nov", "An event"),
      companyPastedLine("26 Nov", "An event"),
    ];
    for (const s of [...ALL_PASTE_STRINGS, ...made]) expect([...dashesIn(s), ...aiTellsIn(s)], s).toEqual([]);
  });

  it("count people and companies for one, many and none", () => {
    expect(batchCountWords({ people: 10, companies: 3 })).toBe("10 people and 3 companies");
    expect(batchCountWords({ people: 1, companies: 0 })).toBe("1 person");
    expect(batchCountWords({ people: 0, companies: 1 })).toBe("1 company");
    expect(batchCountWords({ people: 0, companies: 0 })).toBe("nobody");
    expect(addWords({ people: 10, companies: 3 })).toBe("Add 10 people and 3 companies");
    expect(addedWords({ people: 1, companies: 2 })).toBe("Added 1 person and 2 companies. Each timeline says where the list is from.");
  });

  it("sum up a read list, each part only when not zero", () => {
    expect(readSummary(14, 10, 3, 1)).toBe("Read 14 rows: 10 people and 3 companies to add, 1 left out.");
    expect(readSummary(3, 0, 3, 0)).toBe("Read 3 rows: 3 companies to add.");
    expect(readSummary(1, 0, 0, 1)).toBe("Read 1 row: 1 left out.");
    expect(agentSummary(14, 10, 3, 1)).toBe(
      "Read 14 rows: 10 people and 3 companies to add, 1 left out. Nobody is added until an admin opens the card and adds them. It waits in Review for 7 days.",
    );
  });

  it("say what Review, the timeline and the record pages say", () => {
    expect(reviewDetail({ people: 10, companies: 3 }, "A friend's sheet")).toBe("10 people and 3 companies. Where it's from: A friend's sheet. It goes after 7 days.");
    expect(timelineDetail("Jo Example", "An event")).toBe("By Jo Example. Where it's from: An event");
    expect(timelineDetail(null, "An event")).toBe("Where it's from: An event");
    expect(personPastedLine("Jo Example", "26 Nov", "An event")).toBe("Added from a pasted list by Jo Example on 26 Nov. Where it's from: An event.");
    expect(companyPastedLine("26 Nov", "An event")).toBe("Added from a pasted list on 26 Nov. Where it's from: An event.");
    expect(alreadyAtAdd(1)).toBe("1 was already here, so it was left as it is.");
    expect(fromReview(1)).toBe("1 row was left out when the list was read.");
  });

  it("fall back to a plain failure for an unknown code", () => {
    expect(pasteErrorText({ error: "too_many_rows" })).toBe("That's more than 50 rows. Paste up to 50 at a time.");
    expect(pasteErrorText({ error: "toString" })).toBe("That didn't work. Try again.");
    expect(pasteErrorText(null)).toBe("That didn't work. Try again.");
  });
});
