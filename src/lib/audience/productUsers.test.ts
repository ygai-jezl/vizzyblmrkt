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
    catalog: { onboardingSteps: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  });
  db.seed("product_connections", "pc_sandbox", { tenantId: "ten_A", name: "Sandbox", kind: "sandbox", status: "active", catalog: { onboardingSteps: [] } });
  db.seed("product_users", "pu_1", {
    tenantId: "ten_A",
    connectionId: "pc_prod",
    firstName: "Amara",
    lastName: "Khan",
    email: "Amara.K@example.com",
    emailNormalized: "amara.k@example.com",
    steps: { a: { doneAt: "x" }, b: { doneAt: "y" } },
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
      stepsDone: 2,
      stepsTotal: 3,
      onWaitlist: true,
    });
    expect(rows[0]).toMatchObject({ name: null, onWaitlist: false });
  });
});
