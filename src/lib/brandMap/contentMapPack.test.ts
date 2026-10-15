import { describe, expect, it } from "vitest";
import { packSiblings, type Circle } from "./packSiblings";
import { groupItem, MAX_CIRCLES, packLevel, subjectItem, type PackItem } from "./contentMapPack";

/** A fixed pseudo-random sequence, so the tests are the same every run. */
function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function overlaps(circles: Array<{ x: number; y: number; r: number }>, slack = 1e-6): number {
  let n = 0;
  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      const a = circles[i]!;
      const b = circles[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < a.r + b.r - slack) n += 1;
    }
  }
  return n;
}

const dotCount = (path: string) => (path.match(/M/g) ?? []).length;

function items(n: number, seed = 7): PackItem[] {
  const r = rand(seed);
  return Array.from({ length: n }, (_, i) => {
    const questions = 1 + Math.floor(r() * r() * 40);
    const answered = Math.floor(r() * questions * 0.4);
    return subjectItem({ id: `sub_${i}`, name: `Subject ${i}`, status: r() < 0.05 ? "proposed" : "decided", counts: { questions, answered, drafted: 0, planned: 0, open: questions - answered } });
  });
}

describe("packing circles", () => {
  it("lays circles side by side, none overlapping, all inside the circle it returns", () => {
    const r = rand(3);
    for (const n of [1, 2, 3, 10, 50, 300]) {
      const circles: Circle[] = Array.from({ length: n }, () => ({ x: 0, y: 0, r: 1 + r() * 9 })).sort((a, b) => b.r - a.r);
      const R = packSiblings(circles);
      expect(overlaps(circles, 1e-3)).toBe(0);
      for (const c of circles) expect(Math.hypot(c.x, c.y) + c.r).toBeLessThanOrEqual(R + 1e-3);
    }
  });
});

describe("a level of the content map", () => {
  it("fits the circles in the space, sized by how much each holds, the same on every visit", () => {
    const level = packLevel(items(40), { width: 880, height: 600 });
    expect(level.circles).toHaveLength(40);
    expect(level.more).toBe(0);
    expect(overlaps(level.circles, 0.5)).toBe(0);
    for (const c of level.circles) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(0);
      expect(c.x + c.r).toBeLessThanOrEqual(880);
      expect(c.y - c.r).toBeGreaterThanOrEqual(0);
      expect(c.y + c.r).toBeLessThanOrEqual(600);
      expect(c.showLabel).toBe(c.r >= 34);
    }
    expect(packLevel(items(40), { width: 880, height: 600 })).toEqual(level);
    expect(level.dots.answered.length + level.dots.open.length).toBeGreaterThan(0);
  });

  it("holds up at 5,000 subjects: the biggest 400 can be clicked, the rest are '+N more', quickly", () => {
    const started = performance.now();
    const level = packLevel(items(5000, 11), { width: 880, height: 600 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(level.circles).toHaveLength(MAX_CIRCLES);
    expect(level.more).toBe(5000 - MAX_CIRCLES);
    expect(overlaps(level.circles, 0.5)).toBe(0);
    // Names only where there is room: never all 400 at once.
    expect(level.circles.filter((c) => c.showLabel).length).toBeLessThan(MAX_CIRCLES);
    expect(dotCount(level.dots.answered) + dotCount(level.dots.drafted) + dotCount(level.dots.open)).toBeLessThanOrEqual(6000);
  });

  it("past a few hundred, a dot stands for a share, in the same proportions", () => {
    const big = subjectItem({ id: "sub_big", name: "Big", status: "decided", counts: { questions: 500, answered: 300, drafted: 0, planned: 0, open: 200 } });
    const level = packLevel([big], { width: 600, height: 600 });
    expect(dotCount(level.dots.answered)).toBe(240);
    expect(dotCount(level.dots.drafted)).toBe(0);
    expect(dotCount(level.dots.open)).toBe(160);
  });

  it("draws a group's subjects inside it by how far along each is", () => {
    expect(groupItem({ id: "grp_a", name: "Tracking", totals: { subjects: 3, questions: 11, answered: 4, subjectsAnswered: 2, subjectsDrafted: 0, subjectsOpen: 1 } })).toEqual({
      id: "grp_a",
      label: "Tracking",
      value: 11,
      score: "4 of 11 answered",
      dots: { answered: 2, drafted: 0, open: 1 },
    });
    expect(packLevel([], { width: 100, height: 100 })).toMatchObject({ circles: [], more: 0 });
  });
});
