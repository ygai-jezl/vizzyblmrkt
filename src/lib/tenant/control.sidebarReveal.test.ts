import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { addSidebarShown, startSidebarReveal } from "./control";
import { getTenantById } from "./registry";

const AT = "2026-11-25T10:00:00.000Z";

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  for (const [id, extra] of [
    ["ten_A", over],
    ["ten_B", {}],
  ] as const) {
    db.seed("tenants", id, {
      tenantName: `Brand ${id}`,
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...extra,
    });
  }
  return db;
}

describe("starting the brand's sidebar when the welcome first finishes", () => {
  it("writes the sections it's given, once each, and reads back on the tenant", async () => {
    const db = seeded();
    expect(await startSidebarReveal("ten_A", ["content", "journeys", "content"], AT, db)).toEqual(["content", "journeys"]);
    expect((await getTenantById("ten_A", db))?.sidebarReveal).toEqual({ shown: ["content", "journeys"], opened: [], startedAt: AT });
    expect(db.raw("tenants", "ten_B")!.sidebarReveal).toBeUndefined();
  });

  it("starts with nothing shown when nothing fits, which is still Coming up (not today's sidebar)", async () => {
    const db = seeded();
    expect(await startSidebarReveal("ten_A", [], AT, db)).toEqual([]);
    expect((await getTenantById("ten_A", db))?.sidebarReveal?.shown).toEqual([]);
  });

  it("only adds when it was started already, and writes nothing when nothing is new", async () => {
    const db = seeded({ sidebarReveal: { shown: ["insights"], opened: [{ key: "insights", at: AT }], startedAt: AT } });
    expect(await startSidebarReveal("ten_A", ["content"], "2026-11-26T10:00:00.000Z", db)).toEqual(["insights", "content"]);
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toEqual({
      shown: ["insights", "content"],
      opened: [{ key: "insights", at: AT }],
      startedAt: AT,
    });
    const writes = db.writeCountFor("tenants", "ten_A");
    expect(await startSidebarReveal("ten_A", ["content"], AT, db)).toEqual(["insights", "content"]);
    expect(db.writeCountFor("tenants", "ten_A")).toBe(writes);
  });

  it("leaves a damaged value alone, and a missing brand gives null", async () => {
    const db = seeded({ sidebarReveal: { shown: "content" } });
    expect(await startSidebarReveal("ten_A", ["content"], AT, db)).toBeNull();
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toEqual({ shown: "content" });
    expect(await startSidebarReveal("ten_missing", ["content"], AT, db)).toBeNull();
    expect(db.raw("tenants", "ten_missing")).toBeUndefined();
  });

  it("never keeps a key the schema can't", async () => {
    const db = seeded();
    expect(await startSidebarReveal("ten_A", ["", "x".repeat(33), "content"], AT, db)).toEqual(["content"]);
  });
});

describe("adding to the brand's sidebar", () => {
  const started = { sidebarReveal: { shown: ["content"], opened: [], startedAt: AT } };

  it("is a union that never removes, and writes only when the set grows", async () => {
    const db = seeded(started);
    expect(await addSidebarShown("ten_A", ["audience", "insights"], undefined, db)).toEqual(["content", "audience", "insights"]);
    const writes = db.writeCountFor("tenants", "ten_A");
    expect(await addSidebarShown("ten_A", ["content", "audience"], undefined, db)).toEqual(["content", "audience", "insights"]);
    expect(await addSidebarShown("ten_A", [], undefined, db)).toEqual(["content", "audience", "insights"]);
    expect(db.writeCountFor("tenants", "ten_A")).toBe(writes);
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toMatchObject({ shown: ["content", "audience", "insights"], startedAt: AT });
  });

  it("records Open early with the key and when, only when it shows something new", async () => {
    const db = seeded(started);
    await addSidebarShown("ten_A", ["products"], { key: "products", at: AT }, db);
    await addSidebarShown("ten_A", ["products"], { key: "products", at: "2026-11-27T10:00:00.000Z" }, db);
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toEqual({
      shown: ["content", "products"],
      opened: [{ key: "products", at: AT }],
      startedAt: AT,
    });
  });

  it("keeps only the newest 16 Open early records", async () => {
    const opened = Array.from({ length: 16 }, (_, i) => ({ key: `old${i}`, at: AT }));
    const db = seeded({ sidebarReveal: { shown: ["content"], opened, startedAt: AT } });
    await addSidebarShown("ten_A", ["journeys"], { key: "journeys", at: "2026-11-28T10:00:00.000Z" }, db);
    const stored = (await getTenantById("ten_A", db))?.sidebarReveal;
    expect(stored?.opened).toHaveLength(16);
    expect(stored?.opened[0]?.key).toBe("old1");
    expect(stored?.opened.at(-1)).toEqual({ key: "journeys", at: "2026-11-28T10:00:00.000Z" });
  });

  it("writes nothing for a brand without the field, a damaged one or none at all", async () => {
    const db = seeded();
    expect(await addSidebarShown("ten_A", ["content"], { key: "content", at: AT }, db)).toBeNull();
    expect(db.raw("tenants", "ten_A")!.sidebarReveal).toBeUndefined();
    expect(db.writeCountFor("tenants", "ten_A")).toBe(0);
    const damaged = seeded({ sidebarReveal: { shown: ["content"], startedAt: 7 } });
    expect(await addSidebarShown("ten_A", ["insights"], undefined, damaged)).toBeNull();
    expect(damaged.writeCountFor("tenants", "ten_A")).toBe(0);
    expect(await addSidebarShown("ten_missing", ["content"], undefined, db)).toBeNull();
  });

  it("reads a damaged value as today's sidebar", async () => {
    const db = seeded({ sidebarReveal: { shown: ["content"], startedAt: 7 } });
    expect((await getTenantById("ten_A", db))?.sidebarReveal).toBeUndefined();
    expect((await getTenantById("ten_A", db))?.tenantName).toBe("Brand ten_A");
  });
});
