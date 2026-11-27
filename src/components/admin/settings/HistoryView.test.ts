import { describe, expect, it } from "vitest";
import { summaryOf } from "./HistoryView";
import { dayText, kindsInWords, whenText } from "./historyWords";

describe("History's words", () => {
  it("says what changed in the saver's words, else item by item, and a restore names its version", () => {
    expect(summaryOf({ kind: "fields", message: "Added ‘Plant type’", items: ["Added ‘Plant type’"], restoredFrom: null })).toBe("Added ‘Plant type’.");
    expect(summaryOf({ kind: "connections", message: "Gave ‘Google Analytics, fernhill.example’", items: ["Added ‘fernhill.example’"], restoredFrom: null })).toBe(
      "Gave ‘Google Analytics, fernhill.example’.",
    );
    expect(summaryOf({ kind: "catalogs", message: null, items: ["Added step ‘Book a visit’", "Renamed step ‘Trial’ to ‘First visit’"], restoredFrom: null })).toBe(
      "Added step ‘Book a visit’. Renamed step ‘Trial’ to ‘First visit’.",
    );
    expect(summaryOf({ kind: "fields", message: "Restored version 11", items: ["Restored ‘Delivery day’"], restoredFrom: 11 })).toBe("Restored version 11. Restored ‘Delivery day’.");
    expect(summaryOf({ kind: "journeys", message: "Published, from version 1.", items: [], restoredFrom: 1 })).toBe("Published, from version 1.");
  });

  it("names the kinds in a sentence, and times as the mockups do", () => {
    expect(kindsInWords(["fields", "journeys", "catalogs", "connections"])).toBe("fields, journeys, product catalogs and shared connections");
    expect(kindsInWords(["catalogs"])).toBe("product catalogs");
    const now = Date.parse("2026-11-26T10:00:00.000Z");
    expect(whenText("2026-11-26T08:00:00.000Z", now)).toBe("2 hours ago");
    expect(whenText("2026-11-25T09:00:00.000Z", now)).toBe("yesterday");
    expect(whenText("2026-11-24T10:00:00.000Z", now)).toBe("2 days ago");
    expect(whenText("2026-11-19T10:00:00.000Z", now)).toBe("1 week ago");
    expect(whenText("2026-09-14T10:00:00.000Z", now)).toBe(`on ${dayText("2026-09-14T10:00:00.000Z")}`);
  });
});
