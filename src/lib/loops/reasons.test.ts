import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { IMAGE_VOTE_REASON_KEYS, isVoteReason, VOTE_NOTE_CHARS, VOTE_REASONS, voteReasonLabel } from "./reasons";

describe("the reasons behind a vote", () => {
  it("lists what's off after a thumbs down and what works after a thumbs up, in plain words", () => {
    expect(VOTE_REASONS.image.down.map((r) => r.label)).toEqual([
      "Wrong colours",
      "Wrong mood or style",
      "Wrong subject",
      "Looks fake",
      "Text or details wrong",
      "Not us",
      "Something else",
    ]);
    expect(VOTE_REASONS.image.up.map((r) => r.label)).toEqual(["Colours", "Mood or style", "Subject", "Layout", "Something else"]);
    for (const [kind, dirs] of Object.entries(VOTE_REASONS)) {
      for (const [dir, reasons] of Object.entries(dirs)) {
        const keys = reasons.map((r) => r.key);
        expect(new Set(keys).size, `${kind} ${dir}`).toBe(keys.length);
        for (const r of reasons) {
          // A key sits in a counter's field path as it is, so it has no dots.
          expect(r.key, r.key).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
          expect([...dashesIn(r.label), ...aiTellsIn(r.label)], r.label).toEqual([]);
        }
      }
    }
  });

  it("keeps one key per reason across both directions, and tells the directions apart", () => {
    expect(IMAGE_VOTE_REASON_KEYS).toEqual(["colours", "mood", "subject", "fake", "details", "not_us", "other", "layout"]);
    expect(isVoteReason("image", "down", "fake")).toBe(true);
    expect(isVoteReason("image", "up", "fake")).toBe(false);
    expect(isVoteReason("image", "up", "layout")).toBe(true);
    expect(isVoteReason("image", "down", "nope")).toBe(false);
    expect(voteReasonLabel("image", "down", "colours")).toBe("Wrong colours");
    expect(voteReasonLabel("image", "up", "colours")).toBe("Colours");
    expect(voteReasonLabel("image", "up", "not_us")).toBeNull();
    expect(VOTE_NOTE_CHARS).toBe(200);
  });
});
