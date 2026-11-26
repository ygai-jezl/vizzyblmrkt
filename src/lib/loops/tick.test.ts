import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLoopLane } from "@/lib/tenant/loopLane";
import { LOOP_DAYS, readBrandPointers, readLaneState, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { containerMemoryLimit, isLoopsTick, memoryTooHigh, pageSizeFor, runLoopsLane, signalHash } from "./tick";

/** The loops lane (learning loops step 4, 4.5): its page through the brands, the idle check, the guard and the seed. */

const NOW = new Date("2026-12-16T09:00:00.000Z");
const MIB = 1024 * 1024;
let db: FakeFirestore;

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function brand(id: string, extra: Record<string, unknown> = {}) {
  db.seed("tenants", id, { tenantName: id, rootDomain: `${id}.example.com`, status: "active", region: "us", allowedOrigins: [], ownerId: "usr_x", ...extra });
}

const lane = (over: Parameters<typeof runLoopsLane>[1] = {}) =>
  runLoopsLane(
    { deadlineMs: Date.now() + 60_000 },
    { db, controlDb: db, now: () => NOW, anyTick: true, memory: () => ({ rss: 200 * MIB, heapUsed: 50 * MIB }), memoryLimit: () => null, ...over },
  );

describe("the page", () => {
  it("visits every brand about once a day: 3 runs over 12 brands with K of 5 make 15 visits and reach all 12", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ten_${String(i + 1).padStart(2, "0")}`);
    for (const id of ids) brand(id);
    const visited: string[] = [];
    for (let run = 0; run < 3; run++) visited.push(...(await lane()).visited);
    expect(visited).toHaveLength(15);
    expect(new Set(visited)).toEqual(new Set(ids));
    // The third run reached the end and started again from the first.
    expect(visited.slice(10)).toEqual(["ten_11", "ten_12", "ten_01", "ten_02", "ten_03"]);
    expect((await readLoopLane(db)).cursor).toBe("ten_03");
  });

  it("follows the number of brands, between 5 and 100", () => {
    expect(pageSizeFor(0)).toBe(5);
    expect(pageSizeFor(12)).toBe(5);
    expect(pageSizeFor(1_440)).toBe(10);
    expect(pageSizeFor(14_400)).toBe(100);
    expect(pageSizeFor(1_000_000)).toBe(100);
  });

  it("leaves suspended brands out", async () => {
    brand("ten_a");
    brand("ten_b", { status: "suspended" });
    expect((await lane()).visited).toEqual(["ten_a"]);
  });
});

describe("a brand's visit", () => {
  it("seeds a brand on its first visit, folds, and moves the lane on; the next visit with nothing new is one batched read", async () => {
    brand("ten_hearth", { brandKit: { learnedImageStyle: "Warm natural light, rustic wood and linen." } });
    const first = await lane();
    expect(first).toMatchObject({ brands: 1, idle: 0 });
    const pointers = await readBrandPointers({ tenantId: "ten_hearth", region: "us", source: "system" }, db);
    expect(pointers.seededAt).toBe(NOW.toISOString());
    expect((await getPatternVersion({ tenantId: "ten_hearth", region: "us", source: "system" }, "image_style.brand", 1, db))?.setBy).toBe("seeded");
    const state = await readLaneState({ tenantId: "ten_hearth", region: "us", source: "system" }, db);
    expect(state.foldedThrough).toBeDefined();
    expect(state.seen?.hash).toBe(signalHash([]));
    expect(state.quietUntil! > NOW.toISOString()).toBe(true);

    const opened = () => ({ loopDays: db.collectionCalls(LOOP_DAYS), images: db.collectionCalls("image_assets"), versions: db.collectionCalls("learned_pattern_versions") });
    const before = opened();
    const second = await lane();
    expect(second).toMatchObject({ brands: 1, idle: 1, rows: 0 });
    const after = opened();
    // lb:, ls: and the open week's 5 shards, and nothing else.
    expect(after.loopDays - before.loopDays).toBe(7);
    expect(after.images - before.images).toBe(0);
    expect(after.versions - before.versions).toBe(0);
  });

  it("clears a forgotten look's old copy on the brand record until it is gone", async () => {
    const at = "2026-12-10T09:00:00.000Z";
    brand("ten_hearth", {
      imageStyle: { defaultStyleId: "natural_photo", learned: { natural_photo: { directive: "Overhead daylight.", sampleCount: 3, updatedAt: "2026-12-01T09:00:00.000Z" } } },
    });
    const ctx = { tenantId: "ten_hearth", region: "us" as const, source: "system" as const };
    await runLoopsTransaction(ctx, async (txn) => writeBrandPointersTx(txn, ctx, { scopes: {}, seededAt: at, forgot: { "image_style.natural_photo": { at } } }, db), db);
    await lane();
    expect((db.raw("tenants", "ten_hearth") as { imageStyle: { learned: Record<string, unknown> } }).imageStyle.learned.natural_photo).toBeUndefined();
  });
});

describe("the guards", () => {
  it("runs only with image style versions on, on its own ticks", async () => {
    brand("ten_a");
    expect(isLoopsTick(1 * 120_000)).toBe(true);
    expect(isLoopsTick(5 * 120_000)).toBe(false);
    expect(isLoopsTick(7 * 120_000)).toBe(false);
    expect((await lane({ anyTick: false, now: () => new Date(5 * 120_000) })).skipped).toBe("tick");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(await lane()).toMatchObject({ skipped: "switch", brands: 0 });
    expect(db.dump(LOOP_DAYS)).toEqual([]);
  });

  it("skips its run when the instance holds too much memory", async () => {
    brand("ten_a");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await lane({ memory: () => ({ rss: 700 * MIB, heapUsed: 0 }) })).skipped).toBe("memory");
    expect((await lane({ memory: () => ({ rss: 400 * MIB, heapUsed: 0 }), memoryLimit: () => 512 * MIB })).skipped).toBe("memory");
    expect(log).toHaveBeenCalledWith("[loops] skipped: memory");
    expect(memoryTooHigh(300 * MIB, 1024 * MIB)).toBe(false);
    expect(containerMemoryLimit(() => "max\n")).toBeNull();
    expect(containerMemoryLimit(() => "1073741824\n")).toBe(1024 * MIB);
    expect(containerMemoryLimit(() => {
      throw new Error("no cgroup");
    })).toBeNull();
    expect(db.dump(LOOP_DAYS)).toEqual([]);
  });

  it("hashes what people did, not the lane's own counts, whichever shard it landed in", () => {
    const people = { c: { "image_style.natural_photo": { post_image: { v1: { learned: { liked: 1 } } } } } };
    expect(signalHash([people, undefined])).toBe(signalHash([undefined, people]));
    expect(signalHash([{ ...people, r: { loop_learn: { error: 3 } } }])).toBe(signalHash([people]));
    expect(signalHash([{ o: { image: { liked: 1 } } }])).not.toBe(signalHash([]));
  });
});
