import { describe, it, expect } from "vitest";
import { changeRuns, wordDiff, wordsChanged } from "./wordDiff";

const joined = (segs: ReturnType<typeof wordDiff>, ops: string[]) =>
  segs.filter((s) => ops.includes(s.op)).map((s) => s.text).join("");

describe("wordDiff", () => {
  it("rebuilds both texts: same + del gives the draft, same + ins gives the post", () => {
    const before = "Most onboarding emails are written once and then forgotten.\nWe rewrote ours.";
    const after = "Most onboarding emails are written once and never looked at again.\nWe rewrote ours.";
    const segs = wordDiff(before, after);
    expect(joined(segs, ["same", "ins"])).toBe(after);
    expect(joined(segs, ["del"]).trim()).toBe("then forgotten.");
    expect(joined(segs, ["ins"]).trim()).toBe("never looked at again.");
  });

  it("keeps the post's line breaks in the words both texts share", () => {
    const segs = wordDiff("One line. Two line.", "One line.\n\nTwo line.");
    expect(joined(segs, ["same", "ins"])).toBe("One line.\n\nTwo line.");
    expect(segs.some((s) => s.op !== "same")).toBe(false);
  });

  it("puts a removal before the insertion that replaces it", () => {
    const segs = wordDiff("a big cat", "a small cat");
    expect(segs.map((s) => s.op)).toEqual(["same", "del", "ins", "same"]);
  });
});

describe("changeRuns and wordsChanged", () => {
  it("lists each changed run once and counts the larger side of each", () => {
    const segs = wordDiff(
      "Activation jumped 18% in just one week. 🚀 Read more.",
      "Activation went up in a week. Read more.",
    );
    const runs = changeRuns(segs);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((r) => r.removed).join(" ")).toContain("🚀");
    expect(wordsChanged(segs)).toBe(runs.reduce((n, r) => n + Math.max(r.removed.split(" ").filter(Boolean).length, r.added.split(" ").filter(Boolean).length), 0));
  });

  it("finds nothing when only spacing changed", () => {
    const segs = wordDiff("Hello  world", "Hello world");
    expect(changeRuns(segs)).toEqual([]);
    expect(wordsChanged(segs)).toBe(0);
  });

  it("an added word alone is a run with nothing removed", () => {
    expect(changeRuns(wordDiff("ship it", "ship it today"))).toEqual([{ removed: "", added: "today" }]);
  });
});
