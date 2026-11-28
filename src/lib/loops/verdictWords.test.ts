import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { LookRead } from "@/lib/types/loopDay";
import { BY_LEARNER, LOOP_RULES } from "./registry";
import { verdict } from "./verdict";
import { cantCheck, likesNeeded, lookReadOf, newestRead, shortDay, verdictWords } from "./verdictWords";

/**
 * A look's check in words (learning loops step 4, 3.8): every example the card, History and the
 * help page show is made here from the real verdict(), then held to the writing rules.
 */

/** `hits` of `n` outputs true, the hits spread out, oldest first. */
const outputs = (hits: number, n: number): boolean[] => Array.from({ length: n }, (_, i) => i < hits);

/** A verdict on liked share guarded by remade share, the warm up spent before the windows. */
function read(check: [number, number, number, number], guard: [number, number, number, number] = [4, 40, 4, 40], before = check[1]): { words: (o?: Parameters<typeof verdictWords>[1]) => string; read: LookRead } {
  const [bh, bn, ah, an] = check;
  const [gbh, gbn, gah, gan] = guard;
  const v = verdict({
    line: BY_LEARNER.votes,
    check: { before: outputs(bh, bn), after: outputs(ah, an) },
    guard: { before: outputs(gbh, gbn), after: outputs(gah, gan) },
    prior: { check: 0.5, guard: 0.25 },
    startsAt: LOOP_RULES.warmUp,
  });
  const r = lookReadOf(v, { usableBefore: before, after: an, at: "2027-05-03T09:00:00.000Z" });
  return { words: (o) => verdictWords(r, o), read: r };
}

const EXAMPLES: string[] = [];
const say = (s: string) => {
  EXAMPLES.push(s);
  return s;
};

describe("verdictWords", () => {
  it("says better, same and worse with the counts at the look", () => {
    expect(say(read([14, 40, 34, 40]).words())).toBe("Liked more often: 34 of 40 against 14 of 40 before.");
    expect(say(read([60, 120, 60, 120], [30, 120, 30, 120]).words())).toBe("About the same: liked 60 of 120 against 60 of 120 before.");
    expect(say(read([30, 40, 12, 40]).words({ since: "2027-03-09T10:00:00.000Z", ask: true }))).toBe(
      "Liked less often since 9 Mar: 12 of 40 against 30 of 40 before. Go back to the earlier look?",
    );
    expect(say(read([20, 40, 20, 40], [4, 40, 20, 40]).words({ since: "2027-04-02T10:00:00.000Z", ask: true }))).toBe(
      "Your images were remade more since 2 Apr: 20 of 40 against 4 of 40 before. Go back to the earlier look?",
    );
  });

  it("says what too few would have taken, and when the next check is", () => {
    const r = read([8, 20, 12, 20], [2, 20, 2, 20], 40);
    expect(r.read.call).toBe("too_few");
    expect(r.read.need).toBe(19);
    expect(say(r.words())).toBe("Too few to tell yet. With 8 of 20 liked before, it would take about 19 of 20 to show. Next check at 40 votes.");
    expect(say(r.words({ form: "history" }))).toBe("Too few to tell at 20 votes: liked 12 of 20 against 8 of 20 before.");
  });

  it("says when a check is the last this look can get, and where the windows stop", () => {
    expect(say(read([5, 12, 6, 12], [1, 12, 1, 12], 12).words())).toBe("Too few to tell, and this is the last check this look can get: only 12 votes came before it.");
    const atLast = read([60, 120, 66, 120], [30, 120, 30, 120]);
    if (atLast.read.call === "too_few") expect(say(atLast.words())).toBe("Too few to tell at 120 votes, the last check any look gets.");
  });

  it("says a look can't be checked when too little came before it, and too few to check yet below the first look", () => {
    const first = read([3, 5, 2, 4], [0, 5, 0, 4], 5);
    expect(cantCheck(first.read)).toBe(true);
    expect(say(first.words({ first: true }))).toBe("This first look can't be checked: only 5 votes came before it.");
    expect(say(first.words({ form: "history" }))).toBe("Can't be checked: only 5 votes came before it.");
    const seeded = read([0, 0, 3, 6], [0, 0, 0, 6], 0);
    expect(say(seeded.words({ form: "history" }))).toBe("Can't be checked: nothing came before it.");
    const waiting = read([20, 40, 3, 4], [4, 40, 0, 4], 40);
    expect(say(waiting.words())).toBe("Too few to check yet: 4 of the 10 votes it needs.");
  });

  it("never promises a read the check would not give", () => {
    // At 10 a side, no change can show once 3 or more were liked before (3.8).
    expect(likesNeeded({ hits: 3, n: 10 })).toBeNull();
    expect(likesNeeded({ hits: 8, n: 20 })).toBe(19);
  });

  it("keeps every example to the writing rules", () => {
    expect(EXAMPLES.length).toBeGreaterThan(8);
    for (const line of EXAMPLES) expect([...dashesIn(line), ...aiTellsIn(line)], line).toEqual([]);
  });

  it("dates in UTC, and reads the newest look kept", () => {
    expect(shortDay("2027-01-14T23:30:00.000Z")).toBe("14 Jan");
    expect(shortDay("not a date")).toBeNull();
    const a = read([14, 40, 34, 40]).read;
    const b = { ...read([8, 20, 12, 20], [2, 20, 2, 20], 40).read, look: 20 };
    expect(newestRead({ "20": b, "40": a })).toBe(a);
    expect(newestRead(undefined)).toBeNull();
  });
});
