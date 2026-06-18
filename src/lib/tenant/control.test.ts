import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { addTenantMember } from "./control";
import { getTenantsForUser, getTenantMembership } from "./registry";

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
