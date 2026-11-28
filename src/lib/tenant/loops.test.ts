import { describe, expect, it } from "vitest";
import { TenantIsolationError, TenantValidationError } from "./errors";
import {
  addToLoopDay,
  isoWeekStart,
  LOOP_DAYS,
  loopDayId,
  loopDayTtlAt,
  mergeLaneState,
  readBrandPointers,
  readBrandPointersTx,
  readLaneState,
  readLoopDays,
  runLoopsTransaction,
  stampKeyFor,
  writeBrandPointersTx,
} from "./loops";
import { forTenant } from "./repository";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { TenantContext } from "./types";

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "system" };

describe("loop_days ids", () => {
  it("builds each kind's id from the brand's own id", () => {
    expect(loopDayId.week("ten_hearth", "2026-W48", 3)).toBe("lw:ten_hearth:2026-W48:3");
    expect(loopDayId.folded("ten_hearth", "2026-W48")).toBe("lt:ten_hearth:2026-W48");
    expect(loopDayId.version("ten_hearth", "image_style.natural_photo", 2)).toBe("lv:ten_hearth:image_style.natural_photo:2");
    expect([loopDayId.brand("ten_hearth"), loopDayId.lane("ten_hearth"), loopDayId.key("ten_hearth")]).toEqual(["lb:ten_hearth", "ls:ten_hearth", "lk:ten_hearth"]);
  });

  it("refuses a week, shard, scope, version or brand id that would blur the parts", () => {
    expect(() => loopDayId.week("ten_hearth", "2026-48", 0)).toThrow(TenantValidationError);
    expect(() => loopDayId.week("ten_hearth", "2026-W54", 0)).toThrow(TenantValidationError);
    expect(() => loopDayId.week("ten_hearth", "2026-W48", 5)).toThrow(TenantValidationError);
    expect(() => loopDayId.week("ten_hearth", "2026-W48", 1.5)).toThrow(TenantValidationError);
    expect(() => loopDayId.version("ten_hearth", "image_style:brand", 1)).toThrow(TenantValidationError);
    expect(() => loopDayId.version("ten_hearth", "image_style.brand", -1)).toThrow(TenantValidationError);
    expect(() => loopDayId.brand("ten_a:ten_b")).toThrow(TenantValidationError);
    expect(() => loopDayId.brand("ten_a/x")).toThrow(TenantValidationError);
  });

  it("expires a week's shards 70 days after the week ends, and its folded copy 2 years after", () => {
    expect(isoWeekStart("2026-W48").toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(isoWeekStart("2026-W01").toISOString()).toBe("2025-12-29T00:00:00.000Z");
    expect(isoWeekStart("2026-W53").toISOString()).toBe("2026-12-28T00:00:00.000Z");
    expect(loopDayTtlAt("week", "2026-W48").toISOString()).toBe("2027-02-08T00:00:00.000Z");
    expect(loopDayTtlAt("folded", "2026-W48").toISOString()).toBe("2028-11-29T00:00:00.000Z");
  });
});

describe("loop_days through forTenant", () => {
  it("adds counters in one merged write, keeping scopes with dots as one key, with the expiry", async () => {
    const db = new FakeFirestore();
    const id = loopDayId.week(hearth.tenantId, "2026-W48", 2);
    const ttlAt = loopDayTtlAt("week", "2026-W48");
    await addToLoopDay(hearth, id, { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 1 } } } } } }, { ttlAt }, db);
    await addToLoopDay(hearth, id, { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 1, liked: 1 } } } } } }, { ttlAt }, db);
    expect(db.raw(LOOP_DAYS, id)).toEqual({
      tenantId: "ten_hearth",
      ttlAt,
      d: { c: { "image_style.natural_photo": { post_image: { v1: { learned: { made: 2, liked: 1 } } } } } },
    });
    const [doc, missing] = await readLoopDays(hearth, [id, loopDayId.week(hearth.tenantId, "2026-W48", 0)], db);
    expect(doc?.d).toEqual(db.raw(LOOP_DAYS, id)!.d);
    expect(missing).toBeNull();
    expect(Object.keys(forTenant(hearth, db))).toContain("loopDays");
  });

  it("never reads or writes another brand's documents", async () => {
    const db = new FakeFirestore();
    const theirs = loopDayId.week(lumen.tenantId, "2026-W48", 0);
    await addToLoopDay(lumen, theirs, { t: { image_asset: { made: 4 } } }, {}, db);
    await expect(addToLoopDay(hearth, theirs, { t: { image_asset: { made: 1 } } }, {}, db)).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(readLoopDays(hearth, [theirs], db)).rejects.toBeInstanceOf(TenantIsolationError);
    // Straight through forTenant, an id that isn't Hearth's is refused too.
    await expect(forTenant(hearth, db).loopDays.increment(theirs, { d: { x: 1 } })).rejects.toThrow();
    expect(db.raw(LOOP_DAYS, theirs)).toEqual({ tenantId: "ten_lumen", d: { t: { image_asset: { made: 4 } } } });
    // A document under Hearth's id that another brand wrote reads as missing.
    db.seed(LOOP_DAYS, loopDayId.brand(hearth.tenantId), { tenantId: "ten_lumen", d: { seededAt: "2026-11-01T00:00:00.000Z" } });
    expect(await readBrandPointers(hearth, db)).toEqual({ scopes: {} });
  });
});

describe("the brand's pointers", () => {
  it("move in one transaction, and read back as written", async () => {
    const db = new FakeFirestore();
    expect(await readBrandPointers(hearth, db)).toEqual({ scopes: {} });
    await runLoopsTransaction(
      hearth,
      async (txn) => {
        const now = await readBrandPointersTx(txn, hearth, db);
        writeBrandPointersTx(
          txn,
          hearth,
          { ...now, scopes: { ...now.scopes, "image_style.natural_photo": { v: 1, setBy: "learned", adoptedAt: "2026-11-26T09:00:00.000Z" } }, seededAt: "2026-11-26T08:00:00.000Z" },
          db,
        );
      },
      db,
    );
    expect(await readBrandPointers(hearth, db)).toEqual({
      scopes: { "image_style.natural_photo": { v: 1, setBy: "learned", adoptedAt: "2026-11-26T09:00:00.000Z" } },
      seededAt: "2026-11-26T08:00:00.000Z",
    });
    expect(db.raw(LOOP_DAYS, "lb:ten_hearth")?.tenantId).toBe("ten_hearth");
  });

  it("refuse a pointer that names no version or setter, and a stored document that isn't this brand's", async () => {
    const db = new FakeFirestore();
    await expect(
      runLoopsTransaction(hearth, async (txn) => writeBrandPointersTx(txn, hearth, { scopes: { "image_style.brand": { v: 1, setBy: "vizzy" as never, adoptedAt: "x" } } }, db), db),
    ).rejects.toThrow();
    db.seed(LOOP_DAYS, "lb:ten_hearth", { tenantId: "ten_lumen", d: {} });
    await expect(runLoopsTransaction(hearth, (txn) => readBrandPointersTx(txn, hearth, db), db)).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe("the lane's state and the stamp key", () => {
  it("merges the lane's state without a read", async () => {
    const db = new FakeFirestore();
    expect(await readLaneState(hearth, db)).toEqual({});
    await mergeLaneState(hearth, { foldedThrough: "2026-W47", runs: 3 }, db);
    await mergeLaneState(hearth, { failedDays: 1, lastFailedDay: "2026-11-26" }, db);
    expect(await readLaneState(hearth, db)).toEqual({ foldedThrough: "2026-W47", runs: 3, failedDays: 1, lastFailedDay: "2026-11-26" });
    await expect(mergeLaneState(hearth, { foldedThrough: "last week" }, db)).rejects.toThrow();
  });

  it("mints one key per brand, and a second mint at the same time gets the first one's", async () => {
    const db = new FakeFirestore();
    const a = "a".repeat(43);
    const b = "b".repeat(43);
    const [first, second] = await Promise.all([stampKeyFor(hearth, () => a, db), stampKeyFor(hearth, () => b, db)]);
    expect(first).toBe(second);
    expect(await stampKeyFor(hearth, () => "c".repeat(43), db)).toBe(first);
    expect(await stampKeyFor(lumen, () => b, db)).toBe(b);
    expect(db.raw(LOOP_DAYS, "lk:ten_hearth")).toEqual({ tenantId: "ten_hearth", d: { key: first } });
    await expect(stampKeyFor({ ...hearth, tenantId: "ten_new" }, () => "short", db)).rejects.toThrow();
  });
});
