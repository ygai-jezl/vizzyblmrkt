import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { setTenantNotesRest } from "./control";
import { getTenantById } from "./registry";
import { readNotesRest } from "@/lib/brandNotes/store";

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    brandVoice: { summary: "Warm" },
    ...over,
  });
  return db;
}
const A = { tenantId: "ten_A", region: "us", source: "idtoken" } as const;

describe("how often a brand's notes go into articles by themselves", () => {
  it("is the defaults until the brand sets it, and a damaged value reads as the defaults", async () => {
    expect(await readNotesRest(A, { db: seeded() })).toEqual({ restDays: 30, maxUses: 3 });
    expect(await readNotesRest(A, { db: seeded({ brandNotesRest: { restDays: "soon" } }) })).toEqual({ restDays: 30, maxUses: 3 });
    expect(await readNotesRest({ ...A, tenantId: "ten_missing" }, { db: seeded() })).toEqual({ restDays: 30, maxUses: 3 });
  });

  it("is stored top-level and leaves the rest of the brand alone", async () => {
    const db = seeded();
    expect(await setTenantNotesRest("ten_A", { restDays: 14, maxUses: 5 }, db)).toEqual({ restDays: 14, maxUses: 5 });
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.brandNotesRest).toEqual({ restDays: 14, maxUses: 5 });
    expect(raw.brandVoice).toEqual({ summary: "Warm" });
    expect((await getTenantById("ten_A", db))?.brandNotesRest).toEqual({ restDays: 14, maxUses: 5 });
    expect(await readNotesRest(A, { db })).toEqual({ restDays: 14, maxUses: 5 });
  });

  it("refuses numbers out of range", async () => {
    await expect(setTenantNotesRest("ten_A", { restDays: 400, maxUses: 3 }, seeded())).rejects.toThrow();
    await expect(setTenantNotesRest("ten_A", { restDays: 30, maxUses: 0 }, seeded())).rejects.toThrow();
  });
});
