import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant/repository";
import type { TenantContext } from "@/lib/tenant/types";
import { createLaunch, LaunchIdTakenError } from "./createLaunch";
import { defaultCampaignSettings, type CampaignSettings } from "./campaignSettings";

const ctxA: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

function launch(name: string): CampaignSettings & { createdAt: string } {
  return {
    ...defaultCampaignSettings(),
    waitlistName: name,
    createdAt: "2026-06-19T00:00:00Z",
  };
}

describe("createLaunch", () => {
  it("writes the base id when the slug is free", async () => {
    const db = new FakeFirestore();
    const id = await createLaunch(
      forTenant(ctxA, db).campaigns,
      "early-access",
      launch("Early Access"),
      { explicit: false },
    );
    expect(id).toBe("early-access");
    expect(db.raw("campaigns", "early-access")?.tenantId).toBe("ten_A");
  });

  it("auto-suffixes a DERIVED slug when another tenant already owns it", async () => {
    const db = new FakeFirestore();
    // Brand A takes the obvious slug first.
    await createLaunch(forTenant(ctxA, db).campaigns, "early-access", launch("Early Access"), {
      explicit: false,
    });
    // Brand B picks the same launch name → same derived slug → gets -2.
    const id = await createLaunch(
      forTenant(ctxB, db).campaigns,
      "early-access",
      launch("Early Access"),
      { explicit: false },
    );
    expect(id).toBe("early-access-2");
    // The two launches are distinct docs owned by their respective tenants.
    expect(db.raw("campaigns", "early-access")?.tenantId).toBe("ten_A");
    expect(db.raw("campaigns", "early-access-2")?.tenantId).toBe("ten_B");
  });

  it("walks the suffix chain past multiple collisions", async () => {
    const db = new FakeFirestore();
    await createLaunch(forTenant(ctxA, db).campaigns, "beta", launch("Beta"), { explicit: false });
    await createLaunch(forTenant(ctxB, db).campaigns, "beta", launch("Beta"), { explicit: false }); // beta-2
    const third = await createLaunch(
      forTenant(ctxA, db).campaigns,
      "beta",
      launch("Beta"),
      { explicit: false },
    );
    expect(third).toBe("beta-3");
  });

  it("does NOT suffix an EXPLICIT slug — it throws LaunchIdTakenError", async () => {
    const db = new FakeFirestore();
    await createLaunch(forTenant(ctxA, db).campaigns, "launch", launch("Launch"), {
      explicit: false,
    });
    await expect(
      createLaunch(forTenant(ctxB, db).campaigns, "launch", launch("Launch"), { explicit: true }),
    ).rejects.toBeInstanceOf(LaunchIdTakenError);
    // No `-2` doc was silently created for the explicit attempt.
    expect(db.raw("campaigns", "launch-2")).toBeUndefined();
  });

  it("reports the original id on an explicit collision", async () => {
    const db = new FakeFirestore();
    await createLaunch(forTenant(ctxA, db).campaigns, "vip", launch("VIP"), { explicit: false });
    await expect(
      createLaunch(forTenant(ctxB, db).campaigns, "vip", launch("VIP"), { explicit: true }),
    ).rejects.toMatchObject({ id: "vip" });
  });
});
