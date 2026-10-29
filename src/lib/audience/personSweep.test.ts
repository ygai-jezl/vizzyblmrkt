import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import type { Contact } from "@/lib/types/contact";
import type { ProductConnection } from "@/lib/types/productConnection";
import { markNeedsSync, personIdOf, syncPerson } from "./personSync";
import { sweepPeople } from "./personSweep";

const DAY = 86_400_000;
const person = (db: FakeFirestore, key: string) => db.raw("contacts", personIdOf(TENANT_ID, key)) as Contact | undefined;
const sweepOf = (db: FakeFirestore) => (db.raw("product_connections", CONNECTION_ID) as ProductConnection).personSweep;
const at = (ms: number) => ({ now: () => ms, deadlineMs: ms + 60_000 });

describe("sweepPeople", () => {
  it("rebuilds the people a write path owed a sync", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ada");
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 });
    await markNeedsSync(ctx, "ada@customer.test", db);
    // Before the daily check's hour: only the owed sync runs.
    const early = Date.parse("2026-09-21T03:00:00Z");
    expect(await sweepPeople(ctx, { db, ...at(early) })).toEqual({ synced: 1, checked: 0, failed: 0 });
    expect(person(db, "ada@customer.test")!.needsSync).toBe(false);
    expect(sweepOf(db)).toBeUndefined();
  });

  it("moves stages as the clocks pass, once a day", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "bea");
    await syncPerson(ctx, "bea@customer.test", { db, nowMs: T0 });
    expect(person(db, "bea@customer.test")!.memberOf).toContain(`stage:${CONNECTION_ID}:new`);

    const later = T0 + 3 * DAY;
    expect(await sweepPeople(ctx, { db, ...at(later) })).toMatchObject({ checked: 1, failed: 0 });
    expect(person(db, "bea@customer.test")!.memberOf).toContain(`stage:${CONNECTION_ID}:onboarding`);
    expect(sweepOf(db)).toMatchObject({ status: "done", checked: 1 });
    // Done for today.
    expect((await sweepPeople(ctx, { db, ...at(later + 60_000) })).checked).toBe(0);
  });

  it("finds a product user the write path missed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "cal");
    await sweepPeople(ctx, { db, ...at(T0) });
    expect(person(db, "cal@customer.test")!.products).toHaveLength(1);
  });

  it("picks the day's check up on the next tick where time ran out, keeping people who share a sync time", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    // Eli and Fay were sent in one batch, so they share a sync time.
    const synced = { dee: 1, eli: 2, fay: 2, gus: 3, hal: 4 };
    for (const [name, minutes] of Object.entries(synced)) seedUser(db, name, { lastSeenAt: new Date(T0 - minutes * 60_000).toISOString() });
    let calls = 0;
    // The clock runs out after the first page.
    const now = () => T0 + (calls++ > 4 ? 120_000 : 0);
    await sweepPeople(ctx, { db, now, deadlineMs: T0 + 60_000, pageSize: 2 });
    expect(sweepOf(db)).toMatchObject({ status: "running" });
    await sweepPeople(ctx, { db, ...at(T0 + 1000), pageSize: 2 });
    expect(sweepOf(db)).toMatchObject({ status: "done" });
    for (const name of ["dee", "eli", "fay", "gus", "hal"]) expect(person(db, `${name}@customer.test`)).toBeDefined();
  });

  it("reports what the backfill would do without writing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "ivy");
    expect((await syncPerson(ctx, "ivy@customer.test", { db, nowMs: T0, dryRun: true })).outcome).toBe("created");
    expect(person(db, "ivy@customer.test")).toBeUndefined();
    await syncPerson(ctx, "ivy@customer.test", { db, nowMs: T0 });
    expect((await syncPerson(ctx, "ivy@customer.test", { db, nowMs: T0, dryRun: true })).outcome).toBe("unchanged");
    expect((await syncPerson(ctx, "ivy@customer.test", { db, nowMs: T0 + 3 * DAY, dryRun: true })).outcome).toBe("updated");
  });
});
