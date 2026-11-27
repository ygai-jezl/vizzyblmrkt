import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { SuggestedTaskSchema } from "@/lib/work/suggestion";
import { SEED_TENANT_ID } from "./seedDemo";
import { SEED_WORK_SUGGESTIONS, seedWorkSuggestions } from "./seedWork";

// The demo brand's made-up Work suggestions, for a local run's Review.
describe("the demo Work suggestions", () => {
  it("are three made-up suggestions in the house style, of the shape Vizzy's would be", () => {
    expect(SEED_WORK_SUGGESTIONS).toHaveLength(3);
    for (const s of SEED_WORK_SUGGESTIONS) {
      expect(SuggestedTaskSchema.safeParse(s).success, s.title).toBe(true);
      for (const text of [s.title, s.description, s.from, s.why, s.proposed?.reason ?? ""]) {
        expect(dashesIn(text), text).toEqual([]);
        expect(aiTellsIn(text), text).toEqual([]);
      }
    }
  });

  it("wait in the demo brand's Review once, however often the seed runs", async () => {
    const db = new FakeFirestore();
    const T = "2026-11-20T09:00:00.000Z";
    db.seed("tenants", SEED_TENANT_ID, { tenantName: "Acme", rootDomain: "acme.test", ownerId: "seed", status: "active", region: "us", allowedOrigins: [], createdAt: T, updatedAt: T, organisationId: `org_${SEED_TENANT_ID}`, orgPlan: "self_hosted" });
    db.seed("organisations", `org_${SEED_TENANT_ID}`, { name: "Acme", plan: "self_hosted", planSince: T, brandIds: [SEED_TENANT_ID], ownerIds: [], createdBy: "seed", createdAt: T, updatedAt: T });
    const deps = { controlDb: db, regionDb: () => db, now: () => new Date(T) };
    expect(await seedWorkSuggestions("uid_demo_admin", deps)).toBe(3);
    expect(await seedWorkSuggestions("uid_demo_admin", deps)).toBe(3);
    expect(db.dump("agent_actions")).toHaveLength(3);
  });
});
