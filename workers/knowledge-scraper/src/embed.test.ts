import { describe, it, expect } from "vitest";
import { planEmbedBatches, mapWithConcurrency, type EmbedItem } from "./embed";

const item = (chars: number): EmbedItem => ({ content: "x".repeat(chars) });

describe("planEmbedBatches", () => {
  it("returns nothing for no items", () => {
    expect(planEmbedBatches([])).toEqual([]);
  });

  it("keeps small items in a single request", () => {
    const items = [item(100), item(100), item(100)];
    expect(planEmbedBatches(items)).toHaveLength(1);
  });

  it("splits by the ~12k token budget (4000 chars ≈ 1000 tokens each)", () => {
    // 25 × 1000 tokens = 25,000 → 12 fit per request, then 12, then 1.
    const batches = planEmbedBatches(Array.from({ length: 25 }, () => item(4000)));
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(12);
    expect(batches[1]).toHaveLength(12);
    expect(batches[2]).toHaveLength(1);
  });

  it("caps at 250 instances per request", () => {
    const batches = planEmbedBatches(Array.from({ length: 300 }, () => item(1)));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(250);
    expect(batches[1]).toHaveLength(50);
  });

  it("places a single oversize item alone (server autotruncates it)", () => {
    const batches = planEmbedBatches([item(400_000)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it("preserves order and loses no items", () => {
    const items = Array.from({ length: 60 }, (_, i) => item(4000 + i));
    const flat = planEmbedBatches(items).flat();
    expect(flat).toEqual(items);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion timing", async () => {
    const items = [40, 10, 30, 20, 5];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i; // return the index to verify ordering
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
