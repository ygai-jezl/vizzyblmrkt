import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import * as words from "./words";

/** Every string in words.ts, with each function called on sample values. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    const f = value as (...a: unknown[]) => unknown;
    // A note's parts are a list; every other function takes numbers or words.
    stringsIn(f === words.NOTE_WORDS.refreshed ? f(["slide 4 sign-ups 4,310 to 4,402"]) : f(3, "sample"), out);
  }
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

describe("the Raise kit's words", () => {
  it("are in house style: no dashes as punctuation and none of the AI tells", () => {
    const all = stringsIn(words);
    expect(all.length).toBeGreaterThan(100);
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
    }
  });

  it("keep the UK reminder exactly as the plan wrote it", () => {
    expect(words.UK_PROMOTION_REMINDER).toBe(
      "Sending this deck to invite investment is a financial promotion in the UK. Send it only to people an exemption covers. Ask your lawyer which one applies.",
    );
  });
});
