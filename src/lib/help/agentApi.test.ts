import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { agentSetupStatus } from "./agentApi";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent" };
const ORIGIN = "https://app.example.com";

const SWITCHES = ["ONBOARDING_ENABLED", "NEXT_PUBLIC_LIFECYCLE_ENABLED", "LIFECYCLE_ENABLED", "LAUNCH_IDEAS_ENABLED"];

/** A brand with one launch and its welcome email live: Get ready is where it is. */
function seeded(answers?: Record<string, string>): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Fernhill Plants",
    rootDomain: "fernhill.example",
    status: "active",
    region: "us",
    allowedOrigins: ["https://fernhill.example"],
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(answers ? { businessProfile: { status: "done", via: "questions", answers, rev: 1, startedAt: "2026-11-25T09:00:00.000Z" } } : {}),
  });
  db.seed("campaigns", "c1", { tenantId: "ten_A", waitlistName: "Gift boxes", createdAt: "2026-11-01T00:00:00Z" });
  db.seed("journeys", "journey_c1", { tenantId: "ten_A", status: "active" });
  // Another brand's answers never reach this one.
  db.seed("tenants", "ten_B", {
    tenantName: "Other Co",
    rootDomain: "other.test",
    status: "active",
    region: "us",
    allowedOrigins: ["https://other.test"],
    ownerId: "usr_other",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    businessProfile: { status: "done", answers: { want: "waitlist" }, rev: 1, startedAt: "2026-11-25T09:00:00.000Z" },
  });
  return db;
}

describe("the setup status Vizzy reads", () => {
  beforeEach(() => {
    for (const name of SWITCHES) delete process.env[name];
  });
  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
  });

  it("has no nextAction with the switch off, and reads the brand only for the setup steps", async () => {
    const db = seeded({ want: "audience" });
    const r = await agentSetupStatus(ctx, db, ORIGIN);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("nextAction");
    expect((r.body.currentStage as { key: string }).key).toBe("ready");
    expect(db.collectionCalls("tenants")).toBe(1);
  });

  it("gives the stage and step Home's Your next action shows, from the brand's answers", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    const db = seeded({ run: "shop", stage: "established", want: "audience" });
    const r = await agentSetupStatus(ctx, db, ORIGIN);
    expect(r.status).toBe(200);
    // Where the brand is doesn't change: Get ready, with its own next step.
    expect(r.body.currentStage).toMatchObject({ key: "ready", position: 1 });
    expect(r.body.nextStep).toMatchObject({ label: "Verify your sending domain" });
    // What Home's card lists: content first, for an audience.
    expect(r.body.nextAction).toEqual({
      stage: { key: "grow", label: "Grow audience", position: 3, of: 3 },
      step: {
        label: expect.stringMatching(/^Start a content /),
        appLink: "/admin/workspace",
        howTo: `${ORIGIN}/help/programmes-and-knowledge#start`,
        warning: null,
      },
    });
    // One more read of the brand, for its answers.
    expect(db.collectionCalls("tenants")).toBe(2);
  });

  it("is the current stage and step with no answers, or with no record of the brand", async () => {
    process.env.ONBOARDING_ENABLED = "true";
    const r = await agentSetupStatus(ctx, seeded(), ORIGIN);
    expect(r.body.nextAction).toMatchObject({ stage: { key: "ready" }, step: { label: "Verify your sending domain" } });

    const missing = await agentSetupStatus({ ...ctx, tenantId: "ten_missing" }, seeded({ want: "audience" }), ORIGIN);
    expect(missing.status).toBe(200);
    expect(missing.body.nextAction).toMatchObject({ stage: { key: "ready" } });
  });
});
