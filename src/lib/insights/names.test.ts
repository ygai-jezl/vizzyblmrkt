import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { emailHref, emailNames } from "./names";

const ctx = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as unknown as TenantContext;

function world(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("campaigns", "team-spaces", { tenantId: "ten_A", waitlistName: "Team spaces", createdAt: "2026-10-28T00:00:00.000Z" });
  db.seed("campaigns", "their-launch", { tenantId: "ten_B", waitlistName: "Not yours", createdAt: "2026-10-28T00:00:00.000Z" });
  return db;
}

const wordsOn = () => {
  for (const k of ["NEXT_PUBLIC_NAV_V2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "NEXT_PUBLIC_NAV_IDEAS_ENABLED", "LAUNCH_IDEAS_ENABLED"]) {
    vi.stubEnv(k, "true");
  }
};
afterEach(() => vi.unstubAllEnvs());

describe("Insights' names for a launch's emails", () => {
  it("name the launch, and a launch that's gone (or another brand's) as a launch", async () => {
    const names = await emailNames(ctx, ["journey_team-spaces", "invite_team-spaces", "journey_their-launch", "invite_gone"], world());
    expect(names.get("journey_team-spaces")).toBe("Welcome & nurture · Team spaces");
    expect(names.get("invite_team-spaces")).toBe("Product invite · Team spaces");
    expect(names.get("journey_their-launch")).toBe("Welcome & nurture · a launch");
    expect(names.get("invite_gone")).toBe("Product invite · a launch");
  });

  it("call one that's gone an idea while the words are on", async () => {
    wordsOn();
    const names = await emailNames(ctx, ["journey_team-spaces", "invite_gone"], world());
    expect(names.get("journey_team-spaces")).toBe("Welcome & nurture · Team spaces");
    expect(names.get("invite_gone")).toBe("Product invite · an idea");
  });

  it("send each to where it's edited, whatever the words", () => {
    expect(emailHref("journey_team-spaces")).toBe("/admin/launches/team-spaces/journey");
    expect(emailHref("invite_team-spaces")).toBe("/admin/launches/team-spaces/invites");
  });
});
