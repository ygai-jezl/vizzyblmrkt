import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { countLiveLaunches } from "./liveLaunches";

const ctx = { tenantId: "ten_A", region: "us" as const };

function seedLaunches(db: FakeFirestore, tenantId: string, n: number, archived: (i: number) => unknown = () => undefined) {
  for (let i = 0; i < n; i += 1) {
    const a = archived(i);
    db.seed("campaigns", `${tenantId}_c${String(i).padStart(4, "0")}`, { tenantId, name: `Launch ${i}`, ...(a === undefined ? {} : { archivedAt: a }) });
  }
}

describe("countLiveLaunches", () => {
  it("counts launches with no archivedAt or a null one, and leaves archived ones out", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "c1", { tenantId: "ten_A" });
    db.seed("campaigns", "c2", { tenantId: "ten_A", archivedAt: null });
    db.seed("campaigns", "c3", { tenantId: "ten_A", archivedAt: "2026-10-01T00:00:00.000Z" });

    expect(await countLiveLaunches(ctx, {}, db)).toEqual({ count: 2, capped: false });
  });

  it("never counts another brand's launches", async () => {
    const db = new FakeFirestore();
    seedLaunches(db, "ten_A", 2);
    seedLaunches(db, "ten_B", 5);

    expect(await countLiveLaunches(ctx, {}, db)).toEqual({ count: 2, capped: false });
    expect(await countLiveLaunches({ tenantId: "ten_none", region: "us" }, {}, db)).toEqual({ count: 0, capped: false });
  });

  it("pages past the page size", async () => {
    const db = new FakeFirestore();
    seedLaunches(db, "ten_A", 23, (i) => (i % 4 === 0 ? "2026-10-01T00:00:00.000Z" : undefined));

    expect(await countLiveLaunches(ctx, { pageSize: 5 }, db)).toEqual({ count: 17, capped: false });
    expect(await countLiveLaunches(ctx, { pageSize: 23 }, db)).toEqual({ count: 17, capped: false });
  });

  it("stops at max and says the count is capped", async () => {
    const db = new FakeFirestore();
    seedLaunches(db, "ten_A", 12);

    expect(await countLiveLaunches(ctx, { max: 10, pageSize: 4 }, db)).toEqual({ count: 10, capped: true });
    expect(await countLiveLaunches(ctx, { max: 12, pageSize: 4 }, db)).toEqual({ count: 12, capped: false });
    expect(await countLiveLaunches(ctx, { max: 11, pageSize: 50 }, db)).toEqual({ count: 11, capped: true });
  });
});
