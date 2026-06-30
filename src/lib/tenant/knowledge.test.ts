import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { verifyOwner } from "./knowledge";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

describe("verifyOwner", () => {
  it("is true for an owned campaign or workspace", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "c1", { tenantId: "ten_A", waitlistName: "C" });
    db.seed("workspaces", "w1", { tenantId: "ten_A", name: "W" });
    expect(await verifyOwner(ctx, "campaign", "c1", db)).toBe(true);
    expect(await verifyOwner(ctx, "workspace", "w1", db)).toBe(true);
  });

  it("is false for a foreign-tenant or missing owner (no cross-tenant access)", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "w1", { tenantId: "ten_OTHER", name: "W" });
    expect(await verifyOwner(ctx, "workspace", "w1", db)).toBe(false);
    expect(await verifyOwner(ctx, "workspace", "missing", db)).toBe(false);
    expect(await verifyOwner(ctx, "campaign", "missing", db)).toBe(false);
  });
});
