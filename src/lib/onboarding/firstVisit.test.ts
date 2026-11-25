import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { shouldWelcome } from "./firstVisit";

const ctx: TenantContext = { tenantId: "ten_new", region: "us", source: "system" };
const fresh = { businessProfile: undefined };
const nothing = { recordsEver: 0, signups: 0 };

/** What Home reads, for a brand seeded with `seed`. */
async function signalsFor(seed: (db: FakeFirestore) => void = () => {}) {
  const db = new FakeFirestore();
  seed(db);
  return loadGrowthSignals(ctx, { lifecycle: true }, db);
}

describe("who Home sends to the welcome", () => {
  it("a new brand's admin", async () => {
    expect(shouldWelcome(fresh, await signalsFor(), "admin")).toBe(true);
  });

  it("never a member, nor someone whose role isn't known", () => {
    expect(shouldWelcome(fresh, nothing, "member")).toBe(false);
    expect(shouldWelcome(fresh, nothing, undefined)).toBe(false);
  });

  it("never when the brand, its records or its sign-ups couldn't be read", async () => {
    expect(shouldWelcome(null, nothing, "admin")).toBe(false);
    expect(shouldWelcome(fresh, { recordsEver: 0, signups: null }, "admin")).toBe(false);
    expect(shouldWelcome(fresh, { recordsEver: null, signups: 0 }, "admin")).toBe(false);
    const failed = await loadGrowthSignals(ctx, { lifecycle: true }, failingFirestore(new FakeFirestore(), { collections: ["campaigns"] }));
    expect(shouldWelcome(fresh, failed, "admin")).toBe(false);
  });

  it("never again once the brand has a profile, whatever its status", () => {
    for (const status of ["started", "done", "skipped"] as const) {
      expect(shouldWelcome({ businessProfile: { status, answers: {}, rev: 0, startedAt: "2026-11-25T10:00:00.000Z" } }, nothing, "admin")).toBe(false);
    }
  });

  it("never for a brand whose only launch is archived", async () => {
    const s = await signalsFor((db) =>
      db.seed("campaigns", "c_arch", { tenantId: "ten_new", waitlistName: "Gone", createdAt: "2026-09-10T00:00:00Z", archivedAt: "2026-09-11T00:00:00Z" }),
    );
    expect(s.activeLaunches).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("never for a brand with only a sandbox connection", async () => {
    const s = await signalsFor((db) =>
      db.seed("product_connections", "pc_sandbox", { tenantId: "ten_new", kind: "sandbox", status: "active", createdAt: "2026-09-03T00:00:00Z" }),
    );
    expect(s.products).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("never for a brand with sign-ups, even with nothing else", async () => {
    const s = await signalsFor((db) => db.seed("signups", "s1", { tenantId: "ten_new", status: "unverified", createdAt: "2026-09-01T00:00:00Z" }));
    expect(s.recordsEver).toBe(0);
    expect(shouldWelcome(fresh, s, "admin")).toBe(false);
  });

  it("another brand's records don't count against a new one", async () => {
    const s = await signalsFor((db) => db.seed("campaigns", "c_b", { tenantId: "ten_B", waitlistName: "Theirs", createdAt: "2026-09-10T00:00:00Z" }));
    expect(shouldWelcome(fresh, s, "admin")).toBe(true);
  });
});
