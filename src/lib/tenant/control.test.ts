import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { addTenantMember, updateTenantConfig } from "./control";
import { getTenantsForUser, getTenantMembership } from "./registry";

describe("updateTenantConfig", () => {
  it("never writes the organisation link or the plan copy, and writes the rest", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", {
      tenantName: "Acme",
      region: "us",
      organisationId: "org_ten_A",
      orgPlan: "free",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    // A caller that slips them in anyway (the type refuses them).
    const patch = { tenantName: "Acme Labs", organisationId: "org_other", orgPlan: "enterprise", region: "eu" };
    await updateTenantConfig("ten_A", patch as never, db);

    const doc = db.raw("tenants", "ten_A")!;
    expect(doc.tenantName).toBe("Acme Labs");
    expect(doc.organisationId).toBe("org_ten_A");
    expect(doc.orgPlan).toBe("free");
    expect(doc.region).toBe("us");
    expect(doc.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("addTenantMember", () => {
  it("records a membership that the registry reads back", async () => {
    const db = new FakeFirestore();
    await addTenantMember("usr_1", "ten_A", "admin", db);

    const m = await getTenantMembership("usr_1", "ten_A", db);
    expect(m).toMatchObject({ userId: "usr_1", tenantId: "ten_A", role: "admin" });
    expect(typeof m?.joinedAt).toBe("string");
  });

  it("is idempotent — a repeat call neither throws nor creates a duplicate row", async () => {
    const db = new FakeFirestore();
    await addTenantMember("usr_1", "ten_A", "admin", db);
    await addTenantMember("usr_1", "ten_A", "member", db); // deterministic id → no-op

    const all = await getTenantsForUser("usr_1", db);
    expect(all).toHaveLength(1);
    expect(all[0]!.role).toBe("admin"); // first write wins (atomic create)
  });
});
