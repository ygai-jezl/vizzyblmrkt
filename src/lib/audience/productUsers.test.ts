import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadAudienceProductUsers } from "./productUsers";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

function seed(db: FakeFirestore) {
  db.seed("product_connections", "pc_prod", {
    tenantId: "ten_A",
    name: "Fernlight app (production)",
    kind: "custom",
    status: "active",
    catalog: { onboardingSteps: [{ id: "a", label: "a", order: 0 }, { id: "b", label: "b", order: 1 }, { id: "c", label: "c", order: 2 }] },
  });
  db.seed("product_connections", "pc_sandbox", { tenantId: "ten_A", name: "Sandbox", kind: "sandbox", status: "active", catalog: { onboardingSteps: [] } });
  db.seed("product_users", "pu_1", {
    tenantId: "ten_A",
    connectionId: "pc_prod",
    firstName: "Amara",
    lastName: "Khan",
    email: "Amara.K@example.com",
    emailNormalized: "amara.k@example.com",
    // `old` was a step once; it's no longer in the catalog, so it doesn't count.
    steps: { a: { doneAt: "x" }, b: { doneAt: "y" }, old: { doneAt: "z" } },
    lastSeenAt: "2026-09-23T10:00:00Z",
    status: "active",
  });
  db.seed("product_users", "pu_2", {
    tenantId: "ten_A",
    connectionId: "pc_prod",
    email: "ben@example.net",
    emailNormalized: "ben@example.net",
    steps: {},
    lastSeenAt: "2026-09-23T11:00:00Z",
    status: "active",
  });
  db.seed("product_users", "pu_gone", { tenantId: "ten_A", connectionId: "pc_prod", steps: {}, lastSeenAt: "2026-09-23T12:00:00Z", status: "deleted" });
  db.seed("product_users", "pu_test", { tenantId: "ten_A", connectionId: "pc_sandbox", steps: {}, lastSeenAt: "2026-09-23T13:00:00Z", status: "active" });
  db.seed("contacts", "ct_1", { tenantId: "ten_A", contactKey: "amara.k@example.com", status: "active" });
}

describe("loadAudienceProductUsers", () => {
  it("lists real products' users, newest first, flagging waitlist signups", async () => {
    const db = new FakeFirestore();
    seed(db);
    const rows = await loadAudienceProductUsers(ctx, db);
    expect(rows.map((r) => r.id)).toEqual(["pu_2", "pu_1"]); // deleted and sandbox users left out
    expect(rows[1]).toMatchObject({
      name: "Amara Khan",
      product: "Fernlight app · Production",
      onboarding: { done: 2, total: 3, next: "c", about: null, activated: false },
      onWaitlist: true,
    });
    expect(rows[0]).toMatchObject({ name: null, onWaitlist: false });
  });

  it("counts steps done per brand when the catalog keeps them per brand", async () => {
    const db = new FakeFirestore();
    db.seed("product_connections", "pc_brand", {
      tenantId: "ten_A",
      name: "Brand app",
      kind: "custom",
      status: "active",
      catalog: {
        onboardingSteps: [{ id: "a", label: "A", order: 0, kind: "brand" }, { id: "b", label: "B", order: 1, kind: "brand" }],
        entityKinds: [{ kind: "brand", label: "brand", plural: "brands" }],
      },
    });
    const brand = (name: string, steps: Record<string, { doneAt: string }>) => ({ kind: "brand", name, role: "owner", steps, facts: {}, firstSeenAt: "x" });
    db.seed("product_users", "pu_b", {
      tenantId: "ten_A",
      connectionId: "pc_brand",
      steps: {},
      entities: { b1: brand("Acme", { a: { doneAt: "x" } }), b2: brand("Beta", {}) },
      lastSeenAt: "2026-09-23T10:00:00Z",
      status: "active",
    });
    const [row] = await loadAudienceProductUsers(ctx, db);
    expect(row?.onboarding).toMatchObject({ done: 1, total: 2, next: "B", about: "Acme (+1 brand)" });
  });
});
