import { describe, it, expect, beforeEach, vi } from "vitest";
import { isRateLimited, __resetRateLimitState, type RateLimitConfig } from "./rateLimit";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { FirestoreLike } from "./types";

const cfg: RateLimitConfig = { prefix: "ingest", burstLimit: 3, hourlyLimit: 5 };

describe("isRateLimited", () => {
  beforeEach(() => __resetRateLimitState());

  it("allows up to the per-minute limit, then rejects until the minute rolls over", async () => {
    const db = new FakeFirestore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(await isRateLimited("key_a", cfg, { db, now: t0 + i })).toBe(false);
    }
    expect(await isRateLimited("key_a", cfg, { db, now: t0 + 10 })).toBe(true);
    expect(await isRateLimited("key_a", cfg, { db, now: t0 + 60_000 })).toBe(false);
  });

  it("enforces the hourly limit across minutes", async () => {
    const db = new FakeFirestore();
    const t0 = 1_000_000;
    const minute = 60_000;
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await isRateLimited("key_a", cfg, { db, now: t0 + i * minute }));
    }
    expect(results).toEqual([false, false, false, false, false, true]);
  });

  it("shares the count across instances through Firestore", async () => {
    const db = new FakeFirestore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) await isRateLimited("key_a", cfg, { db, now: t0 });
    __resetRateLimitState(); // a fresh instance: empty in-memory windows
    expect(await isRateLimited("key_a", cfg, { db, now: t0 + 1 })).toBe(true);
  });

  it("keeps subjects and prefixes independent, and never stores the raw subject", async () => {
    const db = new FakeFirestore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) await isRateLimited("key_a", cfg, { db, now: t0 });
    expect(await isRateLimited("key_b", cfg, { db, now: t0 })).toBe(false);
    expect(await isRateLimited("key_a", { ...cfg, prefix: "other" }, { db, now: t0 })).toBe(false);
    const stored = JSON.stringify(db.dump("rate_limits"));
    expect(stored).not.toContain("key_a");
    expect(db.dump("rate_limits")[0]).toMatchObject({ ttl: expect.any(Date) });
  });

  it("fails open on a Firestore error, relying on the in-memory limiter", async () => {
    const broken = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: vi.fn(async () => {
        throw new Error("UNAVAILABLE");
      }),
    } as unknown as FirestoreLike;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isRateLimited("key_a", cfg, { db: broken, now: 1 })).toBe(false);
    for (let i = 0; i < 2; i += 1) await isRateLimited("key_a", cfg, { db: broken, now: 1 });
    expect(await isRateLimited("key_a", cfg, { db: broken, now: 1 })).toBe(true); // in-memory cap
    errSpy.mockRestore();
  });
});
