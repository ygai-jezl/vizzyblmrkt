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
  type VerdictInput,
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
/** How every reason line that quotes estimated levels ends. */
const ESTIMATES = " Estimates lean toward the default while outputs are few. Not adjusted for season.";

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

const run = (line: Line, check: Outputs, guard: Outputs, more: { prior?: typeof PRIOR; startsAt?: VerdictInput["startsAt"] } = {}): Verdict =>
  verdict({ line, check, guard, prior: more.prior ?? PRIOR, startsAt: more.startsAt });

interface Sim {
  runs: number;
  seed: number;
  line: Line;
  /** The check's true rate before and after the change. */
  check: readonly [number, number];
  /** The guard's true rate before and after the change. */
  guard: readonly [number, number];
  /** How many outputs the guard's known outputs trail the check's, as unused share is known only 14 days after each draft. */
  lag?: number;
}

interface SimResult {
  /** Share of runs that read better or worse at any look. */
  betterOrWorse: number;
  better: number;
  worse: number;
  same: number;
  /** Share of runs that had read better by each look. */
  betterBy: Record<number, number>;
}

/**
 * Draws a scope's warm up and 120 outputs before a change, then 120 after it, and reads the
 * verdict at every output where either side's look changes as the after windows grow, the way a
 * caller reading after every output would (between looks it gives the same answer). With a lag
 * the guard's outputs trail the check's, and the reads go on until the guard has 120 too.
 */
function simulate(s: Sim): SimResult {
  const rnd = mulberry32(s.seed);
  const lag = s.lag ?? 0;
  let betterOrWorse = 0;
  let better = 0;
  let worse = 0;
  let same = 0;
  const firstBetter: Record<number, number> = Object.fromEntries(LOOK_SIZES.map((n) => [n, 0]));
  for (let r = 0; r < s.runs; r++) {
    const check = { before: draw(rnd, LOOP_RULES.warmUp + LAST, s.check[0]), after: draw(rnd, LAST, s.check[1]) };
    const guard = { before: draw(rnd, LOOP_RULES.warmUp + LAST, s.guard[0]), after: draw(rnd, LAST, s.guard[1]) };
    const calls = new Set<Call>();
    let first: number | null = null;
    let looks = "";
    for (let t = 1; t <= LAST + lag; t++) {
      const k = Math.min(t, LAST);
      const j = Math.min(Math.max(0, t - lag), LAST);
      const now = `${lookAt(LAST, k)} ${lookAt(LAST, j)}`;
      if (now === looks) continue;
      looks = now;
      const v = run(s.line, { before: check.before, after: check.after.slice(0, k) }, { before: guard.before, after: guard.after.slice(0, j) });
      calls.add(v.call);
      if (v.call === "better" && first === null) first = v.check.look;
    }
    if (calls.has("better") || calls.has("worse")) betterOrWorse++;
    if (calls.has("better")) better++;
    if (calls.has("worse")) worse++;
    if (calls.has("same")) same++;
    if (first !== null) firstBetter[first] = (firstBetter[first] ?? 0) + 1;
  }
  let sum = 0;
  const betterBy: Record<number, number> = {};
  for (const n of LOOK_SIZES) betterBy[n] = (sum += firstBetter[n]!) / s.runs;
  return { betterOrWorse: betterOrWorse / s.runs, better: better / s.runs, worse: worse / s.runs, same: same / s.runs, betterBy };
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

  it("would catch a loose rule: the same simulation with a band of 0.001 fails, and so does a plain 95% test against no change at the same five looks (the check above is not empty by accident)", () => {
    // The same simulate() and verdict() as the check above, with the band all but gone.
    for (const band of [0.001, 0.01]) {
      const loose = simulate({ runs: 2000, seed: 5, line: { ...EDITS, band }, check: [0.5, 0.5], guard: [0.5, 0.5] });
      expect(loose.betterOrWorse, String(band)).toBeGreaterThan(LOOP_RULES.falseAlarm);
    }
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

  it("reads better no more often when the guard lags the check, as unused share does 14 days after each draft", () => {
    // A guard read on fewer outputs than the check has a range too wide to show harm, so better waits for it.
    const cases: Array<[Line, readonly [number, number], readonly [number, number]]> = [
      [EDITS, [0.5, 0.1], [0.2, 0.4]],
      [VOTES, [0.3, 0.75], [0.1, 0.4]],
    ];
    for (const [line, check, guard] of cases) {
      const at = (lag: number) => simulate({ runs: 2000, seed: 31, line, check, guard, lag });
      const none = at(0);
      for (const lag of [6, 10, 30, 60]) expect(at(lag).better, `${line.check}, guard ${lag} behind`).toBeLessThanOrEqual(none.better);
    }
    // A guard that did not move costs a lagging better little: it still comes once the guard catches up.
    const flat = simulate({ runs: 1000, seed: 32, line: EDITS, check: [0.5, 0.1], guard: [0.2, 0.2], lag: 30 });
    expect(flat.better).toBeGreaterThan(0.95);
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
      "Too few to tell at 10 outputs a side: edit share went from 5 of 10 to 2 of 10, an estimated 50% to 30%, and no change could have shown as better at this look; the next look is at 20 outputs a side." + ESTIMATES,
    );
  });

  it("two months after reads too few at 20 a side, and quotes the 36 points it would take", () => {
    const v = run(EDITS, { before, after: joined(outputs(6, 20), outputs(0, 4)) }, { before: unusedBefore, after: outputs(2, 24) });
    expect(v.call).toBe("too_few");
    expect(v.look).toBe(20);
    expect(v.smallestVisible).toBeCloseTo(9 / 25, 10);
    expect(v.reason).toBe(
      "Too few to tell at 20 outputs a side: edit share went from 10 of 20 to 6 of 20, an estimated 50% to 34%, and only an estimated change of 36 points or more could have shown as better at this look, the last look this change can reach, since only 26 outputs before it count." +
        ESTIMATES,
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
      expect(v.reason).toMatch(/only an estimated change of \d+ points or more could have shown as better|no change could have shown as better/);
    }
    expect(tooFew / runs).toBeGreaterThan(0.75);
  });
});

describe("the holdback, read only across the fleet", () => {
  // perMonth is one scope's outputs, pooled across every brand in the copy that has not opted out:
  // the holdback is never read for one brand. Neither the cap of 20 outputs per organisation per
  // arm nor the floor of LOOP_RULES.cellOrgs organisations is modelled.
  it("would wait decades for a 1 in 20 holdback to read a band sized change at 12 outputs a month pooled, and months at 1,000 a month", () => {
    const quiet = monthsUntilHoldbackReads({ perMonth: 12, rate: 0.5, band: 0.1 })!;
    expect(quiet).toBeGreaterThan(400);
    expect(quiet).toBeLessThan(430);
    expect(monthsUntilHoldbackReads({ perMonth: 1000, rate: 0.5, band: 0.1 })).toBeCloseTo(quiet * 0.012, 6);
    // A wider band needs (0.15 / 0.1) squared fewer outputs.
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 0.5, band: 0.15 })).toBeCloseTo(quiet / 2.25, 6);
    expect(monthsUntilHoldbackReads({ perMonth: 0, rate: 0.5, band: 0.1 })).toBeNull();
    // A rate at 0 or 1 is read at the most uncertain rate within one band, so it never promises a read today.
    const atZero = monthsUntilHoldbackReads({ perMonth: 12, rate: 0, band: 0.1 })!;
    expect(atZero).toBeGreaterThan(100);
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 1, band: 0.1 })).toBeCloseTo(atZero, 6);
    // At 0 the most uncertain rate within one band is 0.1, so p(1 minus p) is 0.09; at 0.2 and 0.8 it is 0.3 and 0.7, so 0.21.
    expect(atZero).toBeCloseTo((quiet * 0.09) / 0.25, 6);
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 0.2, band: 0.1 })).toBeCloseTo((quiet * 0.21) / 0.25, 6);
    expect(monthsUntilHoldbackReads({ perMonth: 12, rate: 0.8, band: 0.1 })).toBeCloseTo((quiet * 0.21) / 0.25, 6);
  });
});

describe("the calls", () => {
  const clearlyBetter = { before: afterWarmUp(25, 40), after: outputs(2, 40) };
  const quietGuard = { before: afterWarmUp(4, 40), after: outputs(4, 40) };

  it("reads better when the check is wholly past the band, and says a guard too few to read was only not shown to get worse", () => {
    const v = run(EDITS, clearlyBetter, quietGuard);
    expect(v.call).toBe("better");
    expect(v.decidedBy).toBe("check");
    expect(v.look).toBe(40);
    expect(v.guard.call).toBe("too_few");
    expect(v.check.counts).toEqual({ before: { hits: 25, n: 40 }, after: { hits: 2, n: 40 } });
    expect(v.reason).toBe(
      "Better at 40 outputs a side: edit share went from 25 of 40 to 2 of 40, an estimated 61% to 10%, past the 10 point band. Unused share was not shown to get worse, but there are too few outputs to tell: it went from 4 of 40 to 4 of 40, an estimated 14% to 14%." +
        ESTIMATES,
    );
  });

  it("says the guard did not get worse only when it reads better, and quotes a guard that reads same", () => {
    const rising = { before: afterWarmUp(10, 40), after: outputs(30, 40) };
    const v = run(VOTES, rising, { before: afterWarmUp(30, 40), after: outputs(4, 40) });
    expect(v.guard.call).toBe("better");
    expect(v.call).toBe("better");
    expect(v.reason).toBe(
      "Better at 40 outputs a side: liked share went from 10 of 40 to 30 of 40, an estimated 28% to 72%, past the 15 point band, and remade share did not get worse." + ESTIMATES,
    );
    // Same only bounds the guard's change inside the band, so it may have got up to one band worse: the counts show it.
    const same = run(EDITS, { before: afterWarmUp(80, 120), after: outputs(20, 120) }, { before: afterWarmUp(2, 120), after: outputs(6, 120) });
    expect([same.check.call, same.guard.call, same.guard.movedWrongWay, same.call]).toEqual(["better", "same", false, "better"]);
    expect(same.reason).toBe(
      "Better at 120 outputs a side: edit share went from 80 of 120 to 20 of 120, an estimated 66% to 18%, past the 10 point band, and unused share stayed within the band: it went from 2 of 120 to 6 of 120, an estimated 4% to 7%." +
        ESTIMATES,
    );
  });

  it("holds back better while a guard too few to read has its raw range wholly on the worse side of no change", () => {
    const fell = { before: afterWarmUp(32, 40), after: outputs(4, 40) };
    // 8 to 16 of 40: the raw range still holds no change, so better stands, said with care.
    const close = run(EDITS, fell, { before: afterWarmUp(8, 40), after: outputs(16, 40) });
    expect(close.guard.movedWrongWay).toBe(false);
    expect(close.call).toBe("better");
    expect(close.reason).toMatch(/Unused share was not shown to get worse, but there are too few outputs to tell: it went from 8 of 40 to 16 of 40/);
    for (const after of [18, 22]) {
      const v = run(EDITS, fell, { before: afterWarmUp(8, 40), after: outputs(after, 40) });
      expect(v.check.call, String(after)).toBe("better");
      expect(v.guard.call, String(after)).toBe("too_few");
      expect(v.guard.movedWrongWay, String(after)).toBe(true);
      expect(v.guard.rawRange![0], String(after)).toBeGreaterThan(0);
      expect(v.call, String(after)).toBe("too_few");
      expect(v.reason).toBe(
        `Too few to tell at 40 outputs a side: edit share went from 32 of 40 to 4 of 40, an estimated 77% to 14%, past the 10 point band, but unused share went from 8 of 40 to ${after} of 40, an estimated 23% to ${after === 18 ? 46 : 54}%, so it got worse, though not clearly by more than the band; 40 outputs a side is the last look unused share can reach, since only 40 of its outputs before the change count, so this change cannot read better.` +
          ESTIMATES,
      );
    }
  });

  it("says when a guard that holds better back is read again, or that this change cannot read better", () => {
    // 120 a side is the last look there is, so this too few is final.
    const end = run(EDITS, { before: afterWarmUp(80, 120), after: outputs(20, 120) }, { before: afterWarmUp(4, 120), after: outputs(16, 200) });
    expect([end.check.call, end.guard.call, end.guard.movedWrongWay, end.guard.look, end.call]).toEqual(["better", "too_few", true, 120, "too_few"]);
    expect(end.reason).toBe(
      "Too few to tell at 120 outputs a side: edit share went from 80 of 120 to 20 of 120, an estimated 66% to 18%, past the 10 point band, but unused share went from 4 of 120 to 16 of 120, an estimated 5% to 15%, so it got worse, though not clearly by more than the band; the windows stop at 120 outputs a side, so this change cannot read better." +
        ESTIMATES,
    );
    // With 120 usable before the change on both, the guard is read again at 80.
    const room = run(EDITS, { before: joined(outputs(0, 90), outputs(32, 40)), after: outputs(4, 40) }, { before: joined(outputs(0, 90), outputs(8, 40)), after: outputs(18, 40) });
    expect([room.check.call, room.guard.call, room.guard.movedWrongWay, room.call]).toEqual(["better", "too_few", true, "too_few"]);
    expect(room.reason).toBe(
      "Too few to tell at 40 outputs a side: edit share went from 32 of 40 to 4 of 40, an estimated 77% to 14%, past the 10 point band, but unused share went from 8 of 40 to 18 of 40, an estimated 23% to 46%, so it got worse, though not clearly by more than the band; the next look for unused share is at 80 outputs a side." +
        ESTIMATES,
    );
  });

  it("lets better through on a guard that reads same, even when it moved the wrong way inside the band", () => {
    // Remade share 0 to 8 of 120: its raw range sits wholly on the worse side of no change, but inside the 15 point band.
    const v = run(VOTES, { before: afterWarmUp(30, 120), after: outputs(90, 120) }, { before: afterWarmUp(0, 120), after: outputs(8, 120) });
    expect([v.check.call, v.guard.call, v.guard.movedWrongWay]).toEqual(["better", "same", true]);
    expect(v.guard.rawRange![0]).toBeGreaterThan(0);
    expect(v.guard.rawRange![1]).toBeLessThan(VOTES.band);
    expect(v.call).toBe("better");
    expect(v.look).toBe(120);
    expect(v.reason).toBe(
      "Better at 120 outputs a side: liked share went from 30 of 120 to 90 of 120, an estimated 26% to 74%, past the 15 point band, and remade share got worse, but stayed within the band: it went from 0 of 120 to 8 of 120, an estimated 2% to 8%." +
        ESTIMATES,
    );
  });

  it("says a check that moved the wrong way got worse, before what could have shown as better", () => {
    // 10 to 24 of 40: the raw range sits wholly on the worse side of no change, but the estimate is not clearly past the band.
    const v = run(EDITS, { before: afterWarmUp(10, 40), after: outputs(24, 40) }, quietGuard);
    expect([v.call, v.check.call, v.check.movedWrongWay]).toEqual(["too_few", "too_few", true]);
    expect(v.reason).toBe(
      "Too few to tell at 40 outputs a side: edit share went from 10 of 40 to 24 of 40, an estimated 28% to 59%. It got worse, though not clearly by more than the 10 point band, and no change could have shown as better at this look, the last look this change can reach, since only 40 outputs before it count." +
        ESTIMATES,
    );
    const late = run(EDITS, { before: afterWarmUp(32, 120), after: outputs(52, 120) }, { before: afterWarmUp(10, 120), after: outputs(10, 120) });
    expect([late.call, late.check.movedWrongWay]).toEqual(["too_few", true]);
    expect(late.reason).toBe(
      "Too few to tell at 120 outputs a side: edit share went from 32 of 120 to 52 of 120, an estimated 28% to 44%. It got worse, though not clearly by more than the 10 point band, and only an estimated change of 21 points or more could have shown as better at this look; the windows stop at 120 outputs a side." +
        ESTIMATES,
    );
  });

  it("quotes the smallest change in the check's own direction when the check is better higher and the guard lower", () => {
    // Liked share is better higher and remade share lower; from 6 of 20 only a rise can read better, so a mixed up direction reads null.
    const v = run(VOTES, { before: afterWarmUp(6, 20), after: outputs(8, 20) }, { before: afterWarmUp(4, 20), after: outputs(4, 20) });
    expect(v.call).toBe("too_few");
    expect(v.smallestVisible).toBeCloseTo(11 / 25, 10);
    expect(v.reason).toBe(
      "Too few to tell at 20 outputs a side: liked share went from 6 of 20 to 8 of 20, an estimated 34% to 42%, and only an estimated change of 44 points or more could have shown as better at this look, the last look this change can reach, since only 20 outputs before it count." +
        ESTIMATES,
    );
    const even = run(VOTES, { before: afterWarmUp(10, 20), after: outputs(12, 20) }, { before: afterWarmUp(4, 20), after: outputs(4, 20) });
    expect(even.call).toBe("too_few");
    expect(even.smallestVisible).toBeCloseTo(0.4, 10);
    expect(even.reason).toMatch(/and only an estimated change of 40 points or more could have shown as better at this look/);
  });

  it("holds back better on a guard that moved two bands the wrong way, which blending alone would hide", () => {
    const v = run(EDITS, clearlyBetter, { before: afterWarmUp(0, 10), after: outputs(6, 10) });
    expect(v.guard.look).toBe(10);
    expect(v.guard.call).toBe("too_few");
    // Unblended the low end is past the band, so it would read worse; the n / (n + 5) shrink pulls it inside.
    expect(v.guard.rawRange![0]).toBeGreaterThan(EDITS.band);
    expect(v.guard.range![0]).toBeLessThan(EDITS.band);
    expect(v.call).toBe("too_few");
    expect(v.reason).toMatch(
      /but unused share went from 0 of 10 to 6 of 10, an estimated 17% to 57%, so it got worse, though not clearly by more than the band; 10 outputs a side is the last look unused share can reach, since only 10 of its outputs before the change count, so this change cannot read better\./,
    );
  });

  it("reads worse when the guard gets worse, even with the check better", () => {
    const v = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(30, 40) });
    expect(v.check.call).toBe("better");
    expect(v.guard.call).toBe("worse");
    expect(v.call).toBe("worse");
    expect(v.decidedBy).toBe("guard");
    expect(v.reason).toBe("Worse at 40 outputs a side: unused share went from 4 of 40 to 30 of 40, an estimated 14% to 72%, past the 10 point band the wrong way." + ESTIMATES);
  });

  it("lets the guard decide when the check and the guard both read worse, and names both", () => {
    const both = run(EDITS, { before: afterWarmUp(2, 40), after: outputs(25, 40) }, { before: afterWarmUp(4, 40), after: outputs(30, 40) });
    expect([both.check.call, both.guard.call, both.call, both.decidedBy, both.look]).toEqual(["worse", "worse", "worse", "guard", 40]);
    expect(both.reason).toBe(
      "Worse at 40 outputs a side: unused share went from 4 of 40 to 30 of 40, an estimated 14% to 72%, past the 10 point band the wrong way, and so did edit share: it went from 2 of 40 to 25 of 40, an estimated 10% to 61%." +
        ESTIMATES,
    );
  });

  it("reads the guard in its own direction and gives worse on a guard worse whatever the check says", () => {
    // Remade share is better lower while liked share is better higher.
    const rising = { before: afterWarmUp(10, 40), after: outputs(30, 40) };
    const up = run(VOTES, rising, { before: afterWarmUp(4, 40), after: outputs(30, 40) });
    expect([up.check.call, up.guard.call, up.call]).toEqual(["better", "worse", "worse"]);
    const down = run(VOTES, rising, { before: afterWarmUp(30, 40), after: outputs(4, 40) });
    expect([down.check.call, down.guard.call, down.call]).toEqual(["better", "better", "better"]);
    // A check that reads same is still overruled by a guard worse.
    const steady = run(EDITS, { before: afterWarmUp(6, 120), after: outputs(6, 120) }, { before: afterWarmUp(6, 120), after: outputs(60, 120) });
    expect([steady.check.call, steady.guard.call, steady.call]).toEqual(["same", "worse", "worse"]);
    expect(steady.reason).toBe("Worse at 120 outputs a side: unused share went from 6 of 120 to 60 of 120, an estimated 7% to 50%, past the 10 point band the wrong way." + ESTIMATES);
  });

  it("gives the guard's look when a guard worse decides, even before the check has a look", () => {
    // Remade share counts every image, liked share only the voted ones, so the guard can reach a look first.
    const v = run(VOTES, { before: outputs(2, 15), after: outputs(3, 6) }, { before: outputs(0, 40), after: outputs(9, 10) });
    expect(v.check.look).toBeNull();
    expect(v.guard.look).toBe(10);
    expect(v.call).toBe("worse");
    expect(v.decidedBy).toBe("guard");
    expect(v.look).toBe(10);
    expect(v.reason).toMatch(/^Worse at 10 outputs a side: remade share went from 0 of 10 to 9 of 10/);
  });

  it("reads worse when the check is wholly past the band the wrong way", () => {
    const v = run(EDITS, { before: afterWarmUp(2, 40), after: outputs(25, 40) }, quietGuard);
    expect(v.call).toBe("worse");
    expect(v.decidedBy).toBe("check");
    expect(v.reason).toMatch(/^Worse at 40 outputs a side: edit share went from 2 of 40 to 25 of 40, an estimated 10% to 61%/);
  });

  it("reads same when the whole raw range sits inside the band", () => {
    const v = run(EDITS, { before: afterWarmUp(6, 120), after: outputs(6, 120) }, { before: afterWarmUp(6, 120), after: outputs(6, 120) });
    expect(v.call).toBe("same");
    expect(v.look).toBe(120);
    const [low, high] = v.check.rawRange!;
    expect(low).toBeGreaterThan(-EDITS.band);
    expect(high).toBeLessThan(EDITS.band);
    expect(v.reason).toMatch(/^Same at 120 outputs a side: edit share went from 6 of 120 to 6 of 120, an estimated 7% to 7%, and the whole range the change could be in sits inside the 10 point band\./);
  });

  it("names a guard that moved the wrong way on a same, with its counts", () => {
    const steady = { before: afterWarmUp(6, 120), after: outputs(6, 120) };
    // Unused share 4 to 24 of 120: too few against the band, its raw range wholly on the worse side.
    const v = run(EDITS, steady, { before: afterWarmUp(4, 120), after: outputs(24, 120) });
    expect([v.call, v.guard.call, v.guard.movedWrongWay]).toEqual(["same", "too_few", true]);
    expect(v.reason).toBe(
      "Same at 120 outputs a side: edit share went from 6 of 120 to 6 of 120, an estimated 7% to 7%, and the whole range the change could be in sits inside the 10 point band. Unused share got worse, though not clearly by more than the 10 point band: it went from 4 of 120 to 24 of 120, an estimated 5% to 21%." +
        ESTIMATES,
    );
    const wider = run(EDITS, steady, { before: afterWarmUp(10, 120), after: outputs(30, 120) });
    expect([wider.call, wider.guard.call, wider.guard.movedWrongWay]).toEqual(["same", "too_few", true]);
    expect(wider.reason).toMatch(/\. Unused share got worse, though not clearly by more than the 10 point band: it went from 10 of 120 to 30 of 120, an estimated 10% to 26%\./);
    // Liked share flat, remade share 12 to 30 of 120: same reaches liked share at any rate, so this case is common.
    const votes = run(VOTES, { before: afterWarmUp(12, 120), after: outputs(12, 120) }, { before: afterWarmUp(12, 120), after: outputs(30, 120) });
    expect([votes.call, votes.guard.call, votes.guard.movedWrongWay]).toEqual(["same", "too_few", true]);
    expect(votes.reason).toBe(
      "Same at 120 outputs a side: liked share went from 12 of 120 to 12 of 120, an estimated 12% to 12%, and the whole range the change could be in sits inside the 15 point band. Remade share got worse, though not clearly by more than the 15 point band: it went from 12 of 120 to 30 of 120, an estimated 12% to 26%." +
        ESTIMATES,
    );
    // A guard that reads same but moved the wrong way inside the band stayed within it.
    const inside = run(VOTES, { before: afterWarmUp(12, 120), after: outputs(12, 120) }, { before: afterWarmUp(0, 120), after: outputs(8, 120) });
    expect([inside.call, inside.guard.call, inside.guard.movedWrongWay]).toEqual(["same", "same", true]);
    expect(inside.reason).toMatch(/band\. Remade share got worse, but stayed within the band: it went from 0 of 120 to 8 of 120, an estimated 2% to 8%\./);
    // A guard that did not move the wrong way is left out.
    expect(run(EDITS, steady, { before: afterWarmUp(0, 120), after: outputs(5, 120) }).reason).not.toMatch(/Unused share/);
  });

  it("names a guard that moved the wrong way on a too few, and says no change could have shown as better while it did", () => {
    const fell = { before: afterWarmUp(20, 40), after: outputs(16, 40) };
    const v = run(EDITS, fell, { before: afterWarmUp(4, 40), after: outputs(14, 40) });
    expect([v.call, v.check.call, v.guard.call, v.guard.movedWrongWay, v.guard.look]).toEqual(["too_few", "too_few", "too_few", true, 40]);
    // The check alone could read better from 31 points, but not past this guard: no after count does.
    expect(v.smallestVisible).toBeCloseTo(14 / 45, 10);
    for (let after = 0; after <= 40; after++) expect(run(EDITS, { ...fell, after: outputs(after, 40) }, { before: afterWarmUp(4, 40), after: outputs(14, 40) }).call, String(after)).not.toBe("better");
    expect(v.reason).toBe(
      "Too few to tell at 40 outputs a side: edit share went from 20 of 40 to 16 of 40, an estimated 50% to 41%, and no change could have shown as better at this look while unused share got worse, though not clearly by more than the 10 point band: it went from 4 of 40 to 14 of 40, an estimated 14% to 37%; this is the last look this change can reach, since only 40 outputs before it count." +
        ESTIMATES,
    );
    const flat = run(EDITS, { before: afterWarmUp(60, 120), after: outputs(60, 120) }, { before: afterWarmUp(24, 120), after: outputs(44, 120) });
    expect(flat.reason).toBe(
      "Too few to tell at 120 outputs a side: edit share went from 60 of 120 to 60 of 120, an estimated 50% to 50%, and no change could have shown as better at this look while unused share got worse, though not clearly by more than the 10 point band: it went from 24 of 120 to 44 of 120, an estimated 21% to 37%; the windows stop at 120 outputs a side." +
        ESTIMATES,
    );
    // With no change able to show from the check alone, the guard gets a sentence of its own.
    const rose = run(EDITS, { before: afterWarmUp(10, 40), after: outputs(24, 40) }, { before: afterWarmUp(4, 40), after: outputs(14, 40) });
    expect(rose.reason).toMatch(/before it count\. Unused share got worse, though not clearly by more than the 10 point band: it went from 4 of 40 to 14 of 40, an estimated 14% to 37%\./);
    // A guard that lags, or never reaches a look, stands in the way of the smallest change too.
    const lags = run(EDITS, fell, { before: afterWarmUp(4, 40), after: outputs(1, 10) });
    expect(lags.reason).toBe(
      "Too few to tell at 40 outputs a side: edit share went from 20 of 40 to 16 of 40, an estimated 50% to 41%, and only an estimated change of 31 points or more could show as better at this look, once unused share has at least 40 outputs since the change; this is the last look this change can reach, since only 40 outputs before it count." +
        ESTIMATES,
    );
    const never = run(EDITS, fell, { before: afterWarmUp(1, 6), after: outputs(1, 40) });
    expect(never.reason).toBe(
      "Too few to tell at 40 outputs a side: edit share went from 20 of 40 to 16 of 40, an estimated 50% to 41%, and no change can show as better, since unused share has only 6 outputs before the change and a look needs 10; this is the last look this change can reach, since only 40 outputs before it count." +
        ESTIMATES,
    );
  });

  it("never reads better before the guard has reached the check's look", () => {
    // Unused share is known only 14 days after each draft, so the guard can lag the check.
    const lagging = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(0, 6) });
    expect(lagging.check.call).toBe("better");
    expect(lagging.guard.look).toBeNull();
    expect(lagging.call).toBe("too_few");
    expect(lagging.reason).toMatch(/past the 10 point band, but unused share has too few outputs for a look, 40 before the change and 6 since, so better waits until it has at least 40 since\./);
    // A look of its own is not enough: at 10 or 20 a side its range is too wide to show harm.
    for (const since of [10, 34]) {
      const behind = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(1, since) });
      expect([behind.guard.look, behind.call], String(since)).toEqual([since === 10 ? 10 : 20, "too_few"]);
      expect(behind.reason).toBe(
        `Too few to tell at 40 outputs a side: edit share went from 25 of 40 to 2 of 40, an estimated 61% to 10%, past the 10 point band, but unused share has only ${since} outputs since the change, so better waits until it has at least 40.` +
          ESTIMATES,
      );
    }
    // A guard 5 of 10 after 2 of 10 is not shown to get worse at 10 a side, and better still waits for it.
    const unsure = run(EDITS, { before: afterWarmUp(20, 40), after: outputs(2, 40) }, { before: joined(outputs(0, 10), ...Array.from({ length: 5 }, () => outputs(2, 8))), after: outputs(5, 10) });
    expect([unsure.guard.look, unsure.guard.movedWrongWay, unsure.call]).toEqual([10, false, "too_few"]);
    // A guard that lags and moved the wrong way says so too.
    const worse = run(EDITS, clearlyBetter, { before: afterWarmUp(0, 40), after: outputs(6, 10) });
    expect([worse.guard.look, worse.guard.movedWrongWay, worse.call]).toEqual([10, true, "too_few"]);
    expect(worse.reason).toMatch(/so better waits until it has at least 40\. Unused share got worse, though not clearly by more than the 10 point band: it went from 0 of 10 to 6 of 10, an estimated 17% to 57%\./);
    expect(run(EDITS, clearlyBetter, quietGuard).call).toBe("better");
    // A guard that can reach no further than its own look has caught up: 26 before the change caps it at 20.
    const capped = run(EDITS, clearlyBetter, { before: afterWarmUp(4, 26), after: outputs(1, 20) });
    expect([capped.guard.look, capped.call]).toEqual([20, "better"]);
    // So does a guard ahead of the check, as remade share can be with every image counted.
    const ahead = run(VOTES, { before: afterWarmUp(10, 40), after: outputs(30, 40) }, { before: afterWarmUp(4, 80), after: outputs(4, 80) });
    expect([ahead.check.look, ahead.guard.look, ahead.call]).toEqual([40, 80, "better"]);
  });

  it("says a guard with fewer than 10 outputs before the change can never let better through", () => {
    for (const since of [40, 400]) {
      const v = run(EDITS, clearlyBetter, { before: afterWarmUp(1, 6), after: outputs(1, since) });
      expect([v.guard.look, v.call], String(since)).toEqual([null, "too_few"]);
      expect(v.reason).toBe(
        `Too few to tell at 40 outputs a side: edit share went from 25 of 40 to 2 of 40, an estimated 61% to 10%, past the 10 point band, but unused share has too few outputs for a look, 6 before the change and ${since} since; with fewer than 10 before the change it never will, so this change cannot read better.` +
          ESTIMATES,
      );
    }
  });

  it("says not adjusted for season, in one line of house style, whatever it calls", () => {
    const seen = new Set<Call>();
    const rnd = mulberry32(3);
    const verdicts: Verdict[] = [];
    const sizes = [5, 12, 25, 45, 90, 130];
    const size = () => sizes[Math.floor(rnd() * sizes.length)]!;
    for (let r = 0; r < 400; r++) {
      // Each list's length is drawn on its own, so the before window can reach the next look and the guard can lag.
      const [line, n] = [r % 2 ? EDITS : VOTES, sizes[Math.floor(r / 2) % sizes.length]!];
      const rate = () => Math.floor(rnd() * 10) / 10;
      const [a, b, c, d] = [rate(), rate(), rate(), rate()];
      verdicts.push(run(line, { before: draw(rnd, n + 10, a), after: draw(rnd, size(), b) }, { before: draw(rnd, size() + 10, c), after: draw(rnd, size(), d) }));
    }
    const steady = { before: afterWarmUp(6, 120), after: outputs(6, 120) };
    const fell = { before: afterWarmUp(20, 40), after: outputs(16, 40) };
    const hearth = joined(outputs(8, 16), outputs(5, 10), outputs(5, 10));
    verdicts.push(
      run(EDITS, clearlyBetter, quietGuard),
      run(EDITS, steady, steady),
      run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(30, 40) }),
      run(EDITS, { before: afterWarmUp(2, 40), after: outputs(25, 40) }, { before: afterWarmUp(4, 40), after: outputs(30, 40) }),
      run(EDITS, { before: afterWarmUp(80, 120), after: outputs(20, 120) }, { before: afterWarmUp(2, 120), after: outputs(6, 120) }),
      run(VOTES, { before: afterWarmUp(30, 120), after: outputs(90, 120) }, { before: afterWarmUp(0, 120), after: outputs(8, 120) }),
      run(EDITS, { before: afterWarmUp(10, 40), after: outputs(24, 40) }, quietGuard),
      run(EDITS, clearlyBetter, { before: afterWarmUp(8, 40), after: outputs(18, 40) }),
      run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(0, 6) }),
      run(EDITS, clearlyBetter, { before: afterWarmUp(4, 40), after: outputs(1, 10) }),
      run(EDITS, clearlyBetter, { before: afterWarmUp(0, 40), after: outputs(6, 10) }),
      run(EDITS, clearlyBetter, { before: afterWarmUp(1, 6), after: outputs(1, 40) }),
      run(EDITS, { before: afterWarmUp(80, 120), after: outputs(20, 120) }, { before: afterWarmUp(4, 120), after: outputs(16, 200) }),
      run(EDITS, { before: joined(outputs(0, 90), outputs(32, 40)), after: outputs(4, 40) }, { before: joined(outputs(0, 90), outputs(8, 40)), after: outputs(18, 40) }),
      run(EDITS, steady, { before: afterWarmUp(4, 120), after: outputs(24, 120) }),
      run(VOTES, { before: afterWarmUp(12, 120), after: outputs(12, 120) }, { before: afterWarmUp(0, 120), after: outputs(8, 120) }),
      run(EDITS, fell, { before: afterWarmUp(4, 40), after: outputs(14, 40) }),
      run(EDITS, { before: afterWarmUp(10, 40), after: outputs(24, 40) }, { before: afterWarmUp(4, 40), after: outputs(14, 40) }),
      run(EDITS, fell, { before: afterWarmUp(4, 40), after: outputs(1, 10) }),
      run(EDITS, fell, { before: afterWarmUp(1, 6), after: outputs(1, 40) }),
      run(VOTES, { before: outputs(2, 15), after: outputs(3, 6) }, { before: outputs(4, 50), after: outputs(14, 40) }),
      run(EDITS, { before: hearth, after: joined(outputs(2, 10), outputs(0, 2)) }, { before: joined(outputs(2, 16), outputs(2, 20)), after: outputs(1, 12) }),
    );
    // Every template a reason line can take comes up at least once, so each one is held to house style.
    const templates = [
      /^Worse at \d+ outputs a side: [a-z ]+ went from .* the wrong way\./,
      /the wrong way, and so did /,
      /did not get worse\./,
      /stayed within the band: it went/,
      /got worse, but stayed within the band: it went/,
      /was not shown to get worse, but there are too few outputs to tell/,
      /^Same at /,
      /^Same at .*\. [A-Z][a-z]+ share got worse, though not clearly/,
      /^Too few to tell: a look needs/,
      /never count\) and \d+ since\. [A-Z][a-z]+ share got worse/,
      /has too few outputs for a look, \d+ before the change and \d+ since, so better waits/,
      /it never will, so this change cannot read better\./,
      /has only \d+ outputs since the change, so better waits until it has at least \d+\./,
      /so better waits until it has at least \d+\. [A-Z][a-z]+ share got worse/,
      /so it got worse, though not clearly by more than the band; the windows stop at 120 outputs a side, so this change cannot read better\./,
      /so it got worse, though not clearly by more than the band; \d+ outputs a side is the last look/,
      /so it got worse, though not clearly by more than the band; the next look for [a-z ]+ is at \d+ outputs a side\./,
      /and no change could have shown as better at this look; the next look is at \d+ outputs a side\./,
      /could have shown as better at this look; the next look is at \d+ outputs a side\./,
      /could have shown as better at this look, the last look this change can reach/,
      /could have shown as better at this look; the windows stop at 120 outputs a side\./,
      /could have shown as better at this look while [a-z ]+ got worse/,
      /once [a-z ]+ has at least \d+ outputs since the change; /,
      /and no change can show as better, since [a-z ]+ has only \d+ outputs before the change/,
      /\. It got worse, though not clearly by more than the \d+ point band, and /,
      /before it count\. [A-Z][a-z]+ share got worse, though not clearly/,
    ];
    for (const t of templates) expect(verdicts.some((v) => t.test(v.reason)), String(t)).toBe(true);
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
    // The guard leaves out the same warm up and follows startsAt too.
    const guarded = { before, after: outputs(0, 20) };
    expect(run(EDITS, { before, after }, guarded).guard.before).toBeCloseTo(blend({ hits: 0, n: 10 }, PRIOR.guard), 10);
    expect(run(EDITS, { before, after }, guarded, { startsAt: 10 }).guard.before).toBeCloseTo(blend({ hits: 10, n: 20 }, PRIOR.guard), 10);
    // Each list counts its own entries: liked share holds only the voted images, remade share every image.
    const votes = { before: joined(outputs(4, 10), outputs(2, 10)), after: outputs(2, 20) };
    const images = { before: joined(outputs(10, 10), outputs(0, 30)), after: outputs(0, 40) };
    const own = run(VOTES, votes, images);
    expect([own.check.look, own.guard.look]).toEqual([10, 20]);
    expect(own.check.counts!.before).toEqual({ hits: 2, n: 10 });
    // The first 12 voted images came before these lists, but every image the scope made is here.
    const each = run(VOTES, votes, images, { startsAt: { check: 12, guard: 0 } });
    expect([each.check.look, each.guard.look]).toEqual([20, 20]);
    expect(each.check.counts!.before).toEqual({ hits: 6, n: 20 });
    expect(each.guard.counts!.before).toEqual({ hits: 0, n: 20 });
    // One number applies to both lists.
    const both = run(VOTES, votes, images, { startsAt: 12 });
    expect([both.check.look, both.guard.look]).toEqual([20, 40]);
    expect(both.guard.counts!.before).toEqual({ hits: 10, n: 40 });
    const short = run(EDITS, { before: outputs(5, 15), after: outputs(0, 40) }, guard);
    expect(short.look).toBeNull();
    expect(short.reason).toBe(
      "Too few to tell: a look needs 10 outputs on each side, and edit share has 5 before the change (its first 10 never count) and 40 since. Not adjusted for season.",
    );
  });

  it("never names a next look the before window cannot reach", () => {
    const quiet = { before: afterWarmUp(4, 40), after: outputs(4, 40) };
    // 25 before, 15 of them usable after the warm up: look 20 never comes, however many follow.
    const short = joined(outputs(0, 10), outputs(2, 15));
    for (const since of [12, 20, 200]) {
      const v = run(EDITS, { before: short, after: outputs(4, since) }, quiet);
      expect(v.look, String(since)).toBe(10);
      expect(v.reason, String(since)).not.toMatch(/next look/);
      expect(v.reason, String(since)).toMatch(/at this look, the last look this change can reach, since only 15 outputs before it count\./);
    }
    // 36 before, 26 usable: look 40 never comes.
    for (const since of [24, 80]) {
      const v = run(EDITS, { before: outputs(0, 36), after: outputs(0, since) }, quiet);
      expect(v.look, String(since)).toBe(20);
      expect(v.reason, String(since)).not.toMatch(/next look/);
      expect(v.reason, String(since)).toMatch(/the last look this change can reach, since only 26 outputs before it count\./);
    }
    // A warm up and then 10 before: look 10 is all this change will ever get.
    for (const since of [10, 60, 120]) {
      const v = run(EDITS, { before: outputs(10, 20), after: outputs(3, since) }, { before: outputs(2, 20), after: outputs(2, since) });
      expect(v.look, String(since)).toBe(10);
      expect(v.smallestVisible).toBeNull();
      expect(v.reason, String(since)).toBe(
        "Too few to tell at 10 outputs a side: edit share went from 0 of 10 to 3 of 10, an estimated 17% to 37%, and no change could have shown as better at this look, the last look this change can reach, since only 10 outputs before it count." +
          ESTIMATES,
      );
    }
  });

  it("names the next look, the last one this change can reach, or the end of the windows when it quotes the smallest change too", () => {
    const quiet = { before: afterWarmUp(4, 120), after: outputs(4, 120) };
    // 25 before, 15 usable, the last 10 with 8 edited: a change can show, but look 20 never comes.
    const short = run(EDITS, { before: joined(outputs(0, 10), outputs(0, 5), outputs(8, 10)), after: outputs(6, 10) }, quiet);
    expect(short.look).toBe(10);
    expect(short.smallestVisible).toBeCloseTo(7 / 15, 10);
    expect(short.reason).toBe(
      "Too few to tell at 10 outputs a side: edit share went from 8 of 10 to 6 of 10, an estimated 70% to 57%, and only an estimated change of 47 points or more could have shown as better at this look, the last look this change can reach, since only 15 outputs before it count." +
        ESTIMATES,
    );
    // 120 a side is the last look there is.
    const end = run(EDITS, { before: afterWarmUp(60, 120), after: outputs(55, 120) }, quiet);
    expect(end.look).toBe(LAST);
    expect(end.smallestVisible).toBeCloseTo(30 / 125, 10);
    expect(end.reason).toBe(
      "Too few to tell at 120 outputs a side: edit share went from 60 of 120 to 55 of 120, an estimated 50% to 46%, and only an estimated change of 24 points or more could have shown as better at this look; the windows stop at 120 outputs a side." +
        ESTIMATES,
    );
    // With room before the change, it names the next look: 40 usable, the last 20 with 10 edited.
    const room = run(EDITS, { before: joined(outputs(0, LOOP_RULES.warmUp), outputs(10, 20), outputs(10, 20)), after: outputs(8, 20) }, quiet);
    expect(room.look).toBe(20);
    expect(room.smallestVisible).toBeCloseTo(9 / 25, 10);
    expect(room.reason).toMatch(/could have shown as better at this look; the next look is at 40 outputs a side\./);
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

  it("reads same on the raw range, never the blended one", () => {
    // Blending must never make same easier: here the blended range fits inside the band and the raw one does not.
    const c = compare({ hits: 0, n: 40 }, { hits: 0, n: 40 }, "lower", 0.1);
    expect(c.range[1]).toBeLessThan(0.1);
    expect(c.rawRange[1]).toBeGreaterThan(0.1);
    expect(c.call).toBe("too_few");
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
    // The check blends toward its own prior and the guard toward its own, never the other's.
    const apart = run(EDITS, check, guard, { prior: { check: 0, guard: 1 } });
    expect([apart.check.before, apart.check.after]).toEqual([0, 0]);
    expect(apart.guard.before).toBeCloseTo((20 + 5) / 25, 12);
    expect(apart.guard.after).toBeCloseTo((20 + 5) / 25, 12);
    const swapped = run(EDITS, check, guard, { prior: { check: 1, guard: 0 } });
    expect(swapped.check.before).toBeCloseTo(5 / 25, 12);
    expect(swapped.guard.before).toBeCloseTo(20 / 25, 12);
    expect(swapped.call).toBe(reads[1]!.call);
  });

  it("reads too few with no look below 10 outputs a side", () => {
    const v = run(EDITS, { before: outputs(10, 30), after: outputs(0, 9) }, { before: outputs(0, 30), after: outputs(0, 9) });
    expect(v.call).toBe("too_few");
    expect(v.look).toBeNull();
    expect(v.smallestVisible).toBeNull();
    expect(v.check).toEqual({
      meaning: "editShare",
      look: null,
      call: "too_few",
      counts: null,
      movedWrongWay: false,
      before: null,
      after: null,
      change: null,
      range: null,
      rawRange: null,
    });
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
    // Better higher with room to move: from 10 of 20 at liked share's 15 point band it takes 10 more, 40 points.
    expect(smallestVisibleChange({ hits: 10, n: 20 }, "higher", 0.15)).toBeCloseTo(10 / 25, 10);
    expect(smallestVisibleChange({ hits: 6, n: 20 }, "higher", 0.15)).toBeCloseTo(11 / 25, 10);
    expect(smallestVisibleChange({ hits: 6, n: 20 }, "lower", 0.15)).toBeNull();
    // A rise from h of n reads like a fall from n minus h, at every look and count.
    for (const band of [BY_LEARNER.edits.band, BY_LEARNER.votes.band])
      for (const n of LOOK_SIZES)
        for (let hits = 0; hits <= n; hits++)
          expect(smallestVisibleChange({ hits, n }, "higher", band), `${hits} of ${n}, band ${band}`).toBe(smallestVisibleChange({ hits: n - hits, n }, "lower", band));
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
    expect(() => run(EDITS, ok, ok, { startsAt: { check: 0, guard: -1 } as never })).toThrow(/startsAt for the guard must be a whole number/);
    expect(() => run({ ...EDITS, check: "sends" }, ok, ok)).toThrow(/check sends needs better and family/);
    expect(() => run({ ...EDITS, check: "searchClicks" }, ok, ok)).toThrow(/check searchClicks is a count, not a share of outputs/);
    expect(() => run({ ...EDITS, guard: "keptShare" }, ok, ok)).toThrow(/guard keptShare shares the family taste/);
    expect(() => run({ ...EDITS, check: "nope" as never }, ok, ok)).toThrow(/not a key/);
    expect(() => compare({ hits: 5, n: 20 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/same number of outputs/);
    expect(() => compare({ hits: 5, n: 15 }, { hits: 5, n: 15 }, "lower", 0.1)).toThrow(/15 outputs a side is not a look/);
    // Even with no room to move, a size that is not a look or a bad band throws rather than reading null.
    expect(() => smallestVisibleChange({ hits: 0, n: 15 }, "lower", 0.1)).toThrow(/15 outputs a side is not a look/);
    expect(() => smallestVisibleChange({ hits: 10, n: 10 }, "higher", 5)).toThrow(/band must be between 0 and 1/);
    expect(() => compare({ hits: 11, n: 10 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/hits that are a whole number from 0 to 10/);
    expect(() => compare({ hits: 2.5, n: 10 }, { hits: 5, n: 10 }, "lower", 0.1)).toThrow(/hits that are a whole number/);
    expect(() => compare({ hits: 5, n: 10 }, { hits: 5, n: 10 }, "up" as never, 0.1)).toThrow(/better must be higher or lower/);
    expect(() => compare({ hits: 5, n: 10 }, { hits: 5, n: 10 }, "lower", 5)).toThrow(/band must be between 0 and 1/);
    expect(() => smallestVisibleChange({ hits: 0, n: 10 }, "up" as never, 0.1)).toThrow(/better must be higher or lower/);
    expect(() => wilson({ hits: 0, n: 0 })).toThrow(/at least one output/);
    expect(() => blend({ hits: 1, n: -1 }, 0.5)).toThrow(/whole number of outputs/);
    expect(() => monthsUntilHoldbackReads({ perMonth: -1, rate: 0.5, band: 0.1 })).toThrow(/outputs a month/);
    expect(() => monthsUntilHoldbackReads({ perMonth: 12, rate: 2, band: 0.1 })).toThrow(/rate must be from 0 to 1/);
  });
});
