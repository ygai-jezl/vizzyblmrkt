import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { previewEngineMove } from "./preview";
import { promoteWaitlistVariant } from "./abTest";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID, welcomeDraft } from "./testing/fixtures";

/** The engine-move dry run and A/B promotion on the lifecycle engine (engine move D3). */

beforeEach(() => vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

function seedOriginal(db: FakeFirestore) {
  db.seed("journeys", `journey_${CAMPAIGN_ID}`, {
    tenantId: TENANT_ID,
    campaignId: CAMPAIGN_ID,
    status: "active",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hi" } },
        { id: "wait1", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 24 } },
        { id: "email2", type: "email", position: { x: 0, y: 0 }, data: { subject: "Next", body: "More" } },
      ],
      edges: [
        { id: "e0", source: "trigger", target: "email1", sourceHandle: null },
        { id: "e1", source: "email1", target: "wait1", sourceHandle: null },
        { id: "e2", source: "wait1", target: "email2", sourceHandle: null },
      ],
    },
  });
  const job = (id: string, status: string) =>
    db.seed("email_jobs", id, { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, type: "journey_step", status, payload: {} });
  job("j1", "pending");
  job("j2", "held");
  job("j3", "done");
}

describe("previewEngineMove", () => {
  it("converts the launch's journey and counts who it affects, without changing anything", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    seedOriginal(db);
    seedSignup(db, "ada");
    seedSignup(db, "grace", { status: "unverified" });
    const before = JSON.stringify([...(await forTenant(system, db).emailJobs.find({}))]);
    const p = (await previewEngineMove(system, CAMPAIGN_ID, db))!;
    expect(p).toMatchObject({
      launch: { id: CAMPAIGN_ID, name: "Fernlight", archived: false },
      original: { exists: true, status: "active", emails: 2, peopleInJourney: 2 },
      verifiedSignups: 1,
      lifecycle: { exists: false, status: null },
      conversion: { ok: true, blocking: [] },
      converted: { emails: 2, abTests: 0 },
    });
    expect(JSON.stringify([...(await forTenant(system, db).emailJobs.find({}))])).toBe(before);
    expect(await forTenant(system, db).lifecycleJourneys.find({})).toHaveLength(0);
  });

  it("reports a launch without a journey, and nothing for an unknown launch", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    expect(await previewEngineMove(system, CAMPAIGN_ID, db)).toMatchObject({ original: { exists: false }, conversion: null, converted: null });
    expect(await previewEngineMove(system, "nope", db)).toBeNull();
  });
});

describe("promoteWaitlistVariant", () => {
  it("sends the winner to everyone from now on, once there's enough data", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    const { journey } = await publishWaitlist(db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    expect(await promoteWaitlistVariant(system, journey.id, "email1", "var_b", { requireMinSample: 1 }, db)).toEqual({ ok: false, error: "insufficient_data" });
    db.seed("email_events", "ev1", { tenantId: TENANT_ID, journeyId: journey.id, nodeId: "email1", variantId: "var_b", type: "send", signupId: "ada", campaignId: CAMPAIGN_ID });
    expect(await promoteWaitlistVariant(system, journey.id, "email1", "var_b", { requireMinSample: 1, nowMs: T0 }, db)).toEqual({ ok: true });
    expect((await forTenant(system, db).lifecycleJourneys.getById(journey.id))!.abWinners).toEqual({ p_email1: "var_b" });
  });

  it("refuses an email without a test, an unknown arm or step", async () => {
    const db = new FakeFirestore();
    seedLaunch(db);
    const { journey } = await publishWaitlist(db, { draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    expect(await promoteWaitlistVariant(system, journey.id, "email2", "control", {}, db)).toEqual({ ok: false, error: "no_ab_test" });
    expect(await promoteWaitlistVariant(system, journey.id, "email1", "var_zz", {}, db)).toEqual({ ok: false, error: "variant_not_found" });
    expect(await promoteWaitlistVariant(system, journey.id, "nope", "control", {}, db)).toEqual({ ok: false, error: "node_not_found" });
    expect(await promoteWaitlistVariant(system, "lcjw_missing", "email1", "control", {}, db)).toEqual({ ok: false, error: "journey_not_found" });
  });
});
