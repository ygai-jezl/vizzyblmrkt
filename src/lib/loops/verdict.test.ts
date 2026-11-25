import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { BY_LEARNER, LOOP_RULES, type Loop } from "./registry";
import {
  blend,
  compare,
  differenceRange,
  isLook,
  lookAt,
  LOOK_SIZES,
  monthsUntilHoldbackReads,
  nextLook,
  ownWeight,
  smallestVisibleChange,
  verdict,
  wilson,
  type Call,
  type Outputs,
  type Tally,
  type Verdict,
} from "./verdict";

/**
 * The verdict (src/lib/loops/verdict.ts, ADR-0019). The simulations draw outputs from a seeded
 * generator, so every run here sees the same outputs and the rates below are exact, not luck.
 */

/** mulberry32: a small seeded generator of numbers from 0 to 1. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Line = Pick<Loop, "check" | "guard" | "band">;
const EDITS: Line = { check: BY_LEARNER.edits.check, guard: BY_LEARNER.edits.guard, band: BY_LEARNER.edits.band };
const VOTES: Line = { check: BY_LEARNER.votes.check, guard: BY_LEARNER.votes.guard, band: BY_LEARNER.votes.band };
const LAST = LOOK_SIZES[LOOK_SIZES.length - 1]!;
const PRIOR = { check: 0.5, guard: 0.5 };

/** n outputs drawn at a true rate. */
function draw(rnd: () => number, n: number, rate: number): boolean[] {
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = rnd() < rate;
  return out;
}
/** n outputs, the first `hits` of them counting toward the meaning. */
const outputs = (hits: number, n: number) => Array.from({ length: n }, (_, i) => i < hits);
/** Lists of outputs joined in order. */
const joined = (...parts: boolean[][]) => parts.flat();
/** A scope's warm up of outputs that are never read, then n outputs with `hits` counting. */
const afterWarmUp = (hits: number, n: number) => joined(outputs(0, LOOP_RULES.warmUp), outputs(hits, n));

const run = (line: Line, check: Outputs, guard: Outputs, more: { prior?: typeof PRIOR; startsAt?: number } = {}): Verdict =>
  verdict({ line, check, guard, prior: more.prior ?? PRIOR, startsAt: more.startsAt });

interface Sim {
  runs: number;
  seed: number;
  line: Line;
  /** The check's true rate before and after the change. */
  check: readonly [number, number];
  /** The guard's true rate before and after the change. */
  guard: readonly [number, number];
}

interface SimResult {
  /** Share of runs that read better or worse at any look. */
  betterOrWorse: number;
  worse: number;
  same: number;
  /** Share of runs that had read better by each look. */
  betterBy: Record<number, number>;
}

/**
 * Draws a scope's warm up and 120 outputs before a change, then 120 after it, and reads the
 * verdict at every look as the after window grows, the way a caller will.
 */
function simulate(s: Sim): SimResult {
  const rnd = mulberry32(s.seed);
  let betterOrWorse = 0;
  let worse = 0;
  let same = 0;
  const firstBetter: Record<number, number> = Object.fromEntries(LOOK_SIZES.map((n) => [n, 0]));
  for (let r = 0; r < s.runs; r++) {
    const check = { before: draw(rnd, LOOP_RULES.warmUp + LAST, s.check[0]), after: draw(rnd, LAST, s.check[1]) };
    const guard = { before: draw(rnd, LOOP_RULES.warmUp + LAST, s.guard[0]), after: draw(rnd, LAST, s.guard[1]) };
    const calls = new Set<Call>();
    let first: number | null = null;
    for (const look of LOOK_SIZES) {
      const v = run(s.line, { before: check.before, after: check.after.slice(0, look) }, { before: guard.before, after: guard.after.slice(0, look) });
      calls.add(v.call);
      if (v.call === "better" && first === null) first = look;
    }
    if (calls.has("better") || calls.has("worse")) betterOrWorse++;
    if (calls.has("worse")) worse++;
    if (calls.has("same")) same++;
    if (first !== null) firstBetter[first] = (firstBetter[first] ?? 0) + 1;
  }
  let sum = 0;
  const betterBy: Record<number, number> = {};
  for (const n of LOOK_SIZES) betterBy[n] = (sum += firstBetter[n]!) / s.runs;
  return { betterOrWorse: betterOrWorse / s.runs, worse: worse / s.runs, same: same / s.runs, betterBy };
}

describe("the verdict's numbers", () => {
  it("reads its looks, blend and warm up from LOOP_RULES", () => {
    expect(LOOK_SIZES).toEqual([10, 20, 40, 80, 120]);
    expect(LOOK_SIZES.slice(0, LOOP_RULES.looks.length)).toEqual([...LOOP_RULES.looks]);
    expect(LAST).toBe(LOOP_RULES.lastLook);
    // A brand's own weight is n / (n + 5): about 0.7 at 12 outputs and 0.9 at 40, as the plan says.
    expect(ownWeight(12)).toBeCloseTo(12 / 17, 10);
    expect(ownWeight(12)).toBeCloseTo(0.7, 1);
    expect(ownWeight(40)).toBeCloseTo(0.9, 1);
    expect(ownWeight(0)).toBe(0);
    expect(blend({ hits: 0, n: 0 }, 0.3)).toBeCloseTo(0.3, 10);
    expect(blend({ hits: 3, n: 12 }, 0.5)).toBeCloseTo((3 + LOOP_RULES.blendM * 0.5) / (12 + LOOP_RULES.blendM), 10);
  });

  it("keeps blendM equal to the PRIOR_N0 default in reward.ts, the precedent it follows", () => {
    const text = readFileSync(join(process.cwd(), "src", "lib", "distribute", "feedback", "reward.ts"), "utf8");
    const m = /const PRIOR_N0 = envNum\("POST_REWARD_PRIOR_N0", (\d+)\)/.exec(text);
    expect(m?.[1], "PRIOR_N0 moved; check blendM still follows it").toBe(String(LOOP_RULES.blendM));
  });

  it("names the looks and the look both sides have reached", () => {
    for (const n of LOOK_SIZES) expect(isLook(n), String(n)).toBe(true);
    for (const n of [0, 9, 11, 35, 60, 160, 200]) expect(isLook(n), String(n)).toBe(false);
    expect(lookAt(9, 100)).toBeNull();
    expect(lookAt(100, 9)).toBeNull();
    expect(lookAt(40, 35)).toBe(20);
    expect(lookAt(500, 500)).toBe(120);
    expect(nextLook(10)).toBe(20);
    expect(nextLook(40)).toBe(80);
    expect(nextLook(120)).toBeNull();
  });

  it("matches the worked examples in Newcombe 1998 and Wilson's interval at 95%", () => {
    const z95 = 1.959964;
    const range = (a: Tally, b: Tally) => differenceRange(b, a, z95).map((x) => Number(x.toFixed(4)));
    expect(range({ hits: 56, n: 70 }, { hits: 48, n: 80 })).toEqual([0.0524, 0.3339]);
    expect(range({ hits: 9, n: 10 }, { hits: 3, n: 10 })).toEqual([0.1705, 0.809]);
    expect(range({ hits: 6, n: 7 }, { hits: 2, n: 7 })).toEqual([0.0582, 0.8062]);
    expect(range({ hits: 5, n: 56 }, { hits: 0, n: 29 })).toEqual([-0.0381, 0.1926]);
    expect(wilson({ hits: 81, n: 263 }, z95).map((x) => Number(x.toFixed(4)))).toEqual([0.2553, 0.3662]);
    expect(wilson({ hits: 15, n: 148 }, z95).map((x) => Number(x.toFixed(4)))).toEqual([0.0624, 0.1605]);
  });
});

describe("a change that did nothing", () => {
  it("reads better or worse at most 5% of the time across all looks, at base rates 0.1, 0.3, 0.5 and 0.8", () => {
    const rates: number[] = [];
    for (const [i, line] of [EDITS, VOTES].entries()) {
      for (const base of [0.1, 0.3, 0.5, 0.8]) {
        for (const guard of [0.1, 0.5]) {
          const r = simulate({ runs: line === EDITS ? 2000 : 1000, seed: 1000 * i + Math.round(base * 100) + guard * 10, line, check: [base, base], guard: [guard, guard] });
          expect(r.betterOrWorse, `${line.check} at ${base}, guard at ${guard}`).toBeLessThanOrEqual(LOOP_RULES.falseAlarm);
          rates.push(r.betterOrWorse);
        }
      }
    }
    // Under 1% in every case when this was written, so the interval has room to spare.
    expect(Math.max(...rates)).toBeLessThan(LOOP_RULES.falseAlarm / 2);
    expect(rates.reduce((s, x) => s + x, 0) / rates.length).toBeLessThan(0.01);
  });

  it("would catch a loose rule: a plain 95% test against no change, read at the same five looks, fails (the check above is not empty by accident)", () => {
    const rnd = mulberry32(5);
    const runs = 3000;
    let alarms = 0;
    for (let r = 0; r < runs; r++) {
      const before = draw(rnd, LAST, 0.5);
      const after = draw(rnd, LAST, 0.5);
      const count = (xs: boolean[], from: number, to: number): Tally => ({ hits: xs.slice(from, to).filter(Boolean).length, n: to - from });
      const fired = LOOK_SIZES.some((n) => {
        const [low, high] = differenceRange(count(before, LAST - n, LAST), count(after, 0, n), 1.959964);
        return low > 0 || high < 0;
      });
      if (fired) alarms++;
    }
    expect(alarms / runs).toBeGreaterThan(LOOP_RULES.falseAlarm);
  });

  it("reads a real change of exactly one band as same at most 5% of the time", () => {
    const cases: Array<[Line, number, number]> = [
      [EDITS, 0.1, 0.2],
      [EDITS, 0.1, 0],
      [EDITS, 0.3, 0.2],
      [EDITS, 0.5, 0.4],
      [EDITS, 0.8, 0.9],
      [EDITS, 0.9, 1],
      [VOTES, 0.1, 0.25],
      [VOTES, 0.3, 0.15],
      [VOTES, 0.8, 0.95],
    ];
    for (const [line, from, to] of cases) {
      const r = simulate({ runs: 1500, seed: 77, line, check: [from, to], guard: [0.3, 0.3] });
      expect(r.same, `${line.check} ${from} to ${to}`).toBeLessThanOrEqual(LOOP_RULES.falseAlarm);
    }
  });
});

describe("a real change", () => {
  it("is called better at a later look when it is large, and rarely at the first", () => {
    const r = simulate({ runs: 2000, seed: 21, line: EDITS, check: [0.5, 0.1], guard: [0.3, 0.3] });
    expect(r.betterBy[10]).toBeLessThan(0.15);
    expect(r.betterBy[40]).toBeGreaterThan(0.6);
    expect(r.betterBy[120]).toBeGreaterThanOrEqual(0.95);
    expect(r.worse).toBeLessThan(0.01);
    const smaller = simulate({ runs: 2000, seed: 22, line: EDITS, check: [0.5, 0.2], guard: [0.3, 0.3] });
    expect(smaller.betterBy[120]).toBeGreaterThan(0.8);
  });

  it("takes its direction from Meaning.better: liked share is better higher, edit share lower", () => {
    const rising = { before: afterWarmUp(12, 40), after: outputs(32, 40) };
    const flat = { before: afterWarmUp(4, 40), after: outputs(4, 40) };
    expect(run(VOTES, rising, flat).call).toBe("better");
    expect(run(EDITS, rising, flat).call).toBe("worse");
  });
});

describe("Hearth Bakery, about 12 drafts a month", () => {
  // Three months of drafts before a change: 16, then 20 with 10 edited (5 in the last 10).
  const before = joined(outputs(8, 16), outputs(5, 10), outputs(5, 10));
  const unusedBefore = joined(outputs(2, 16), outputs(2, 20));

  it("one month after a change reads too few at 10 a side, and says no change could have shown yet", () => {
    const v = run(EDITS, { before, after: joined(outputs(2, 10), outputs(0, 2)) }, { before: unusedBefore, after: outputs(1, 12) });
    expect(v.call).toBe("too_few");
    expect(v.look).toBe(10);
    expect(v.smallestVisible).toBeNull();
    expect(v.reason).toBe(
      "Too few to tell at 10 outputs a side: edit share went from 50% to 30%, and no change could have shown as better at this look; the next look is at 20 outputs a side. Not adjusted for season.",
    );
  });

  it("two months after reads too few at 20 a side, and quotes the 36 points it would take", () => {
    const v = run(EDITS, { before, after: joined(outputs(6, 20), outputs(0, 4)) }, { before: unusedBefore, after: outputs(2, 24) });
    expect(v.call).toBe("too_few");
    expect(v.look).toBe(20);
    expect(v.smallestVisible).toBeCloseTo(9 / 25, 10);
    expect(v.reason).toBe(
      "Too few to tell at 20 outputs a side: edit share went from 50% to 34%, and only a change of 36 points or more could have shown as better. Not adjusted for season.",
    );
  });

  it("mostly reads too few half a year after a real 15 point improvement", () => {
    const rnd = mulberry32(12);
    const runs = 1000;
    let tooFew = 0;
    for (let r = 0; r < runs; r++) {
      // A year of drafts before the change, then six months after it: a look of 40 a side.
      const v = run(EDITS, { before: draw(rnd, 144, 0.5), after: draw(rnd, 72, 0.35) }, { before: draw(rnd, 144, 0.2), after: draw(rnd, 72, 0.2) });
      expect(v.look).toBe(40);
      if (v.call !== "too_few") continue;
      tooFew++;
      expect(v.reason).toMatch(/only a change of \d+ points or more could have shown as better|no change could have shown as better/);
    }
    expect(tooFew / runs).toBeGreaterThan(0.75);
  });

  it("would wait decades for a 1 in 20 holdback to read a band sized change, and a busy copy months", () => {
    const bakery = monthsUntilHoldbackReads({ perMonth: 12, rate: 0.5, band: 0.1 })!;
    expect(bakery).toBeGreaterThan(400);
    expect(bakery).toBeLessThan(430);
    expect(monthsUntilHoldbackReads({ perMonth: 1000, rate: 0.5, band: 0.1 })).toBeCloseTo(bakery * 0.012, 6);
    // A wider band needs (0.15 / 0.1) squared fewer outputs.
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 0.5, band: 0.15 })).toBeCloseTo(bakery / 2.25, 6);
    expect(monthsUntilHoldbackReads({ perMonth: 0, rate: 0.5, band: 0.1 })).toBeNull();
    // A rate at 0 or 1 is read at the most uncertain rate within one band, so it never promises a read today.
    const atZero = monthsUntilHoldbackReads({ perMonth: 12, rate: 0, band: 0.1 })!;
    expect(atZero).toBeGreaterThan(100);
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 1, band: 0.1 })).toBeCloseTo(atZero, 6);
  });
});

describe("the calls", () => {
  const clearlyBetter = { before: afterWarmUp(25, 40), after: outputs(2, 40) };
  const quietGuard = { before: afterWarmUp(4, 40), after: outputs(4, 40) };

  it("reads better when the check is wholly past the band and the guard did not get worse", () => {
    const v = run(EDITS, clearlyBetter, quietGuard);
    expect(v.call).toBe("better");
    expect(v.look).toBe(40);
    expect(v.reason).toBe(
      "Better at 40 outputs a side: edit share went from 61% to 10%, past the 10 point band, and unused share did not get worse. Not adjusted for season.",
    );
  });

  it("reads worse when the guard gets worse, even with the check better", () => {
    const v = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(30, 40) });
    expect(v.check.call).toBe("better");
    expect(v.guard.call).toBe("worse");
    expect(v.call).toBe("worse");
    expect(v.reason).toBe("Worse at 40 outputs a side: unused share went from 14% to 72%, past the 10 point band the wrong way. Not adjusted for season.");
  });

  it("reads worse when the check is wholly past the band the wrong way", () => {
    const v = run(EDITS, { before: afterWarmUp(2, 40), after: outputs(25, 40) }, quietGuard);
    expect(v.call).toBe("worse");
    expect(v.reason).toMatch(/^Worse at 40 outputs a side: edit share went from 10% to 61%/);
  });

  it("reads same when the whole raw range sits inside the band", () => {
    const v = run(EDITS, { before: afterWarmUp(6, 120), after: outputs(6, 120) }, { before: afterWarmUp(6, 120), after: outputs(6, 120) });
    expect(v.call).toBe("same");
    expect(v.look).toBe(120);
    const [low, high] = v.check.rawRange!;
    expect(low).toBeGreaterThan(-EDITS.band);
    expect(high).toBeLessThan(EDITS.band);
    expect(v.reason).toMatch(/^Same at 120 outputs a side: edit share went from 7% to 7%, and the whole range the change could be in sits inside the 10 point band\./);
  });

  it("never reads better before the guard has reached a look of its own", () => {
    // Unused share is known only 14 days after each draft, so the guard can lag the check.
    const lagging = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(0, 6) });
    expect(lagging.check.call).toBe("better");
    expect(lagging.guard.look).toBeNull();
    expect(lagging.call).toBe("too_few");
    expect(lagging.reason).toMatch(/past the 10 point band, but unused share has too few outputs to read yet\./);
    expect(run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(1, 10) }).call).toBe("better");
  });

  it("says not adjusted for season, in one line of house style, whatever it calls", () => {
    const seen = new Set<Call>();
    const rnd = mulberry32(3);
    const verdicts: Verdict[] = [];
    for (let r = 0; r < 400; r++) {
      const [line, n] = [r % 2 ? EDITS : VOTES, [5, 12, 25, 45, 90, 130][r % 6]!];
      const rate = () => Math.floor(rnd() * 10) / 10;
      const [a, b, c, d] = [rate(), rate(), rate(), rate()];
      verdicts.push(run(line, { before: draw(rnd, n + 10, a), after: draw(rnd, n, b) }, { before: draw(rnd, n + 10, c), after: draw(rnd, n, d) }));
    }
    const steady = { before: afterWarmUp(6, 120), after: outputs(6, 120) };
    verdicts.push(run(EDITS, clearlyBetter, quietGuard), run(EDITS, steady, steady), run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(30, 40) }));
    for (const v of verdicts) {
      seen.add(v.call);
      expect(v.notAdjustedForSeason).toBe(true);
      expect(v.reason.endsWith(" Not adjusted for season.")).toBe(true);
      expect(v.reason).not.toMatch(/\n|NaN|undefined|null/);
      expect([...dashesIn(v.reason), ...aiTellsIn(v.reason)], v.reason).toEqual([]);
    }
    expect([...seen].sort()).toEqual(["better", "same", "too_few", "worse"]);
  });
});

describe("windows and looks", () => {
  it("never reads the scope's first 10 outputs as a before window (the warm up)", () => {
    const before = joined(outputs(10, 10), outputs(0, 10));
    const after = outputs(0, 20);
    const guard = { before: outputs(0, 20), after: outputs(0, 20) };
    const fresh = run(EDITS, { before, after }, guard);
    expect(fresh.look).toBe(10);
    expect(fresh.check.before).toBeCloseTo(blend({ hits: 0, n: 10 }, PRIOR.check), 10);
    // The same outputs, said to start 10 into the scope: all 20 can be read, edited ones included.
    const later = run(EDITS, { before, after }, guard, { startsAt: 10 });
    expect(later.look).toBe(20);
    expect(later.check.before).toBeCloseTo(blend({ hits: 10, n: 20 }, PRIOR.check), 10);
    expect(run(EDITS, { before, after }, guard, { startsAt: 4 }).look).toBe(10);
    const short = run(EDITS, { before: outputs(5, 15), after: outputs(0, 40) }, guard);
    expect(short.look).toBeNull();
    expect(short.reason).toBe(
      "Too few to tell: a look needs 10 outputs on each side, and edit share has 5 before the change (the scope's first 10 never count) and 40 since. Not adjusted for season.",
    );
  });

  it("gives the same answer between looks, so calling it after every output finds nothing new", () => {
    const rnd = mulberry32(8);
    for (let r = 0; r < 20; r++) {
      const check = { before: draw(rnd, 130, 0.5), after: draw(rnd, 150, 0.3) };
      const guard = { before: draw(rnd, 130, 0.3), after: draw(rnd, 150, 0.3) };
      const at = (k: number) => run(EDITS, { before: check.before, after: check.after.slice(0, k) }, { before: guard.before, after: guard.after.slice(0, k) });
      for (let k = 10; k <= 150; k++) {
        const look = lookAt(120, k)!;
        if (k === look) continue;
        expect(at(k), `${k} outputs since reads the look at ${look}`).toEqual(at(look));
      }
    }
    expect(run(EDITS, { before: outputs(20, 50), after: outputs(10, 35) }, { before: outputs(5, 50), after: outputs(5, 35) }).look).toBe(20);
  });

  it("shows a change that is exactly the gap between the two blended levels", () => {
    const v = run(EDITS, { before: outputs(30, 50), after: outputs(9, 40) }, { before: outputs(5, 50), after: outputs(5, 40) });
    expect(v.check.change!).toBeCloseTo(v.check.after! - v.check.before!, 12);
    const [low, high] = v.check.range!;
    expect(low).toBeLessThan(v.check.change!);
    expect(high).toBeGreaterThan(v.check.change!);
    // Blending only shrinks: the raw range is the blended one divided by the brand's own weight.
    expect(v.check.rawRange![0] * ownWeight(40)).toBeCloseTo(low, 12);
  });
});

describe("edge cases", () => {
  it("keeps a range wider than zero at no hits and at all hits", () => {
    const [low0, high0] = wilson({ hits: 0, n: 10 });
    expect(low0).toBe(0);
    expect(high0).toBeGreaterThan(0.3);
    const [low10, high10] = wilson({ hits: 10, n: 10 });
    expect(high10).toBe(1);
    expect(low10).toBeLessThan(0.7);
    expect(compare({ hits: 0, n: 10 }, { hits: 0, n: 10 }, "lower", 0.1).call).toBe("too_few");
    expect(compare({ hits: 10, n: 10 }, { hits: 10, n: 10 }, "lower", 0.1).call).toBe("too_few");
    // Stuck at none for 120 outputs a side is same; from all edited to none edited at 10 a side is better.
    expect(compare({ hits: 0, n: 120 }, { hits: 0, n: 120 }, "lower", 0.1).call).toBe("same");
    expect(compare({ hits: 10, n: 10 }, { hits: 0, n: 10 }, "lower", 0.1).call).toBe("better");
    expect(compare({ hits: 0, n: 10 }, { hits: 10, n: 10 }, "lower", 0.1).call).toBe("worse");
  });

  it("lets a prior of 0 or 1 move the levels shown but never the call or the range", () => {
    const check = { before: afterWarmUp(0, 20), after: outputs(0, 20) };
    const guard = { before: afterWarmUp(20, 20), after: outputs(20, 20) };
    const reads = [0, 0.5, 1].map((p) => run(EDITS, check, guard, { prior: { check: p, guard: p } }));
    for (const v of reads) {
      expect(v.call).toBe(reads[1]!.call);
      expect(v.check.range).toEqual(reads[1]!.check.range);
      expect(v.check.rawRange).toEqual(reads[1]!.check.rawRange);
    }
    expect(reads[0]!.check.before).toBe(0);
    expect(reads[2]!.check.before).toBeCloseTo(5 / 25, 12);
    expect(reads[2]!.guard.after).toBe(1);
    expect(reads[1]!.call).toBe("too_few");
  });

  it("reads too few with no look below 10 outputs a side", () => {
    const v = run(EDITS, { before: outputs(10, 30), after: outputs(0, 9) }, { before: outputs(0, 30), after: outputs(0, 9) });
    expect(v.call).toBe("too_few");
    expect(v.look).toBeNull();
    expect(v.smallestVisible).toBeNull();
    expect(v.check).toEqual({ meaning: "editShare", look: null, call: "too_few", before: null, after: null, change: null, range: null, rawRange: null });
    expect(run(EDITS, { before: [], after: [] }, { before: [], after: [] }).call).toBe("too_few");
  });

  it("finds the smallest visible change, which only reads better more easily the further the after count moves", () => {
    // From a 50% before window: none at 10 a side, then 36, 31, 27 and 24 points.
    const from = (n: number) => smallestVisibleChange({ hits: n / 2, n }, "lower", 0.1);
    expect(from(10)).toBeNull();
    expect(from(20)).toBeCloseTo(9 / 25, 10);
    expect(from(40)).toBeCloseTo(14 / 45, 10);
    expect(from(80)).toBeCloseTo(23 / 85, 10);
    expect(from(120)).toBeCloseTo(30 / 125, 10);
    // From 7 of 10 edited it takes all 7, which is 47 points between the blended levels.
    expect(smallestVisibleChange({ hits: 7, n: 10 }, "lower", 0.1)).toBeCloseTo(7 / 15, 10);
    expect(smallestVisibleChange({ hits: 0, n: 10 }, "lower", 0.1)).toBeNull();
    expect(smallestVisibleChange({ hits: 10, n: 10 }, "higher", 0.1)).toBeNull();
    // The search halves the distance, which is right only if better never flips back as the count moves.
    const flips: string[] = [];
    let compared = 0;
    for (const band of [BY_LEARNER.edits.band, BY_LEARNER.votes.band])
      for (const n of LOOK_SIZES)
        for (let hits = 0; hits <= n; hits++)
          for (const better of ["higher", "lower"] as const) {
            const step = better === "higher" ? 1 : -1;
            let seen = false;
            for (let h = hits + step; h >= 0 && h <= n; h += step) {
              const isBetter = compare({ hits, n }, { hits: h, n }, better, band).call === "better";
              compared++;
              if (seen && !isBetter) flips.push(`${hits} of ${n} to ${h}, ${better}, band ${band}`);
              seen ||= isBetter;
            }
          }
    expect(compared).toBeGreaterThan(40000);
    expect(flips).toEqual([]);
  });

  it("throws on mistakes in the caller rather than reading them as too few", () => {
    const ok = { before: outputs(5, 20), after: outputs(5, 20) };
    expect(() => run({ ...EDITS, band: 0 }, ok, ok)).toThrow(/band must be between 0 and 1/);
    expect(() => run({ ...EDITS, band: 1 }, ok, ok)).toThrow(/band must be between 0 and 1/);
    expect(() => run(EDITS, ok, ok, { prior: { check: Number.NaN, guard: 0.5 } })).toThrow(/prior must be from 0 to 1/);
    expect(() => run(EDITS, ok, ok, { prior: { check: 0.5, guard: 1.5 } })).toThrow(/prior must be from 0 to 1/);
    expect(() => run(EDITS, ok, ok, { startsAt: -1 })).toThrow(/startsAt/);
    expect(() => run(EDITS, ok, ok, { startsAt: 2.5 })).toThrow(/startsAt/);
    expect(() => run({ ...EDITS, check: "sends" }, ok, ok)).toThrow(/check sends needs better and family/);
    expect(() => run({ ...EDITS, check: "searchClicks" }, ok, ok)).toThrow(/check searchClicks is a count, not a share of outputs/);
    expect(() => run({ ...EDITS, guard: "keptShare" }, ok, ok)).toThrow(/guard keptShare shares the family taste/);
    expect(() => run({ ...EDITS, check: "nope" as never }, ok, ok)).toThrow(/not a key/);
    expect(() => compare({ hits: 5, n: 20 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/same number of outputs/);
    expect(() => compare({ hits: 5, n: 15 }, { hits: 5, n: 15 }, "lower", 0.1)).toThrow(/15 outputs a side is not a look/);
    expect(() => compare({ hits: 11, n: 10 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/hits that are a whole number from 0 to 10/);
    expect(() => compare({ hits: 2.5, n: 10 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/hits that are a whole number/);
    expect(() => compare({ hits: 5, n: 10 }, { hits: 5, n: 10 }, "up" as never, 0.1)).toThrow(/better must be higher or lower/);
    expect(() => wilson({ hits: 0, n: 0 })).toThrow(/at least one output/);
    expect(() => blend({ hits: 1, n: -1 }, 0.5)).toThrow(/whole number of outputs/);
    expect(() => monthsUntilHoldbackReads({ perMonth: -1, rate: 0.5, band: 0.1 })).toThrow(/outputs a month/);
    expect(() => monthsUntilHoldbackReads({ perMonth: 12, rate: 2, band: 0.1 })).toThrow(/rate must be from 0 to 1/);
  });
});
