import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { runLifecycleTick } from "../runner";
import { sendStub } from "../testing/fixtures";
import { backfillWaitlistJourney, claimLifecycleEngine, enrolWaitlistSignup } from "./enrol";
import { waitlistEnrolmentId, waitlistJourneyId } from "./ids";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID } from "./testing/fixtures";

/**
 * Who enters a waitlist journey on the lifecycle engine (engine move D2), and
 * the rule that keeps anyone from getting both engines' emails.
 */

beforeEach(() => {
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
});
afterEach(() => vi.unstubAllEnvs());

async function world(opts: { mode?: "test" | "live"; testEmails?: string[] } = {}) {
  const db = new FakeFirestore();
  seedLaunch(db);
  const { journey, version } = await publishWaitlist(db, { mode: opts.mode, testEmails: opts.testEmails });
  const campaign = (await forTenant(system, db).campaigns.getById(CAMPAIGN_ID))!;
  const enrol = (signup: ReturnType<typeof seedSignup>, extra: { rehearsal?: boolean } = {}) =>
    enrolWaitlistSignup(system, { journey, version, campaign, signup, source: "trigger", ...extra }, { db, nowMs: T0 });
  return { db, journey, version, campaign, enrol };
}

function legacyJourney(db: FakeFirestore) {
  db.seed("journeys", `journey_${CAMPAIGN_ID}`, {
    tenantId: TENANT_ID,
    campaignId: CAMPAIGN_ID,
    status: "active",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "welcome", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hi" } },
      ],
      edges: [{ id: "e0", source: "trigger", target: "welcome", sourceHandle: null }],
    },
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  });
}

describe("enrolling in a waitlist journey", () => {
  it("stamps the person for the lifecycle engine and enrols them once", async () => {
    const w = await world();
    const ada = seedSignup(w.db, "ada");
    const first = await w.enrol(ada);
    expect(first).toEqual({ outcome: "enrolled", enrolmentId: waitlistEnrolmentId(w.journey.id, "ada"), held: false });
    expect((await forTenant(system, w.db).signups.getById("ada"))!.journeyEngine).toBe("lifecycle");
    expect(await w.enrol({ ...ada, journeyEngine: "lifecycle" })).toMatchObject({ outcome: "duplicate" });
    const e = (await forTenant(system, w.db).waitlistEnrolments.getById(waitlistEnrolmentId(w.journey.id, "ada")))!;
    expect(e).toMatchObject({ campaignId: CAMPAIGN_ID, signupId: "ada", mode: "live", cursor: { nodeId: "email1" }, nextRunAt: new Date(T0).toISOString() });
  });

  it("skips anyone the original engine already emails, stamped or not", async () => {
    const w = await world();
    const stamped = seedSignup(w.db, "ada", { journeyEngine: "legacy" });
    expect(await w.enrol(stamped)).toEqual({ outcome: "skipped", reason: "on_original_engine" });

    // Enrolled on the original engine before stamps existed: found by their queued step, and stamped now.
    legacyJourney(w.db);
    const grace = seedSignup(w.db, "grace");
    const jobId = `journey:journey_${CAMPAIGN_ID}:welcome:grace`;
    w.db.seed("email_jobs", jobId, { tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, type: "journey_step", status: "done", dedupeKey: jobId, payload: {} });
    expect(await w.enrol(grace)).toEqual({ outcome: "skipped", reason: "on_original_engine" });
    expect((await forTenant(system, w.db).signups.getById("grace"))!.journeyEngine).toBe("legacy");
    expect(await forTenant(system, w.db).waitlistEnrolments.find({})).toHaveLength(0);
  });

  it("claims the engine in a transaction: a person stamped meanwhile stays on the original engine", async () => {
    const w = await world();
    const ada = seedSignup(w.db, "ada");
    // The copy the caller holds is stale: the stored signup was stamped "legacy" meanwhile.
    await forTenant(system, w.db).signups.update("ada", { journeyEngine: "legacy" });
    expect(await claimLifecycleEngine(system, ada, w.db)).toBe("legacy");
    expect(await w.enrol(ada)).toEqual({ outcome: "skipped", reason: "on_original_engine" });
  });

  it("only enrols verified people, and in test mode only test recipients", async () => {
    const w = await world({ mode: "test", testEmails: ["grace@example.test"] });
    expect(await w.enrol(seedSignup(w.db, "ada", { status: "unverified" }))).toEqual({ outcome: "skipped", reason: "not_verified" });
    expect(await w.enrol(seedSignup(w.db, "lin"))).toEqual({ outcome: "skipped", reason: "not_a_test_recipient" });
    expect(await w.enrol(seedSignup(w.db, "grace"))).toMatchObject({ outcome: "enrolled" });
  });

  it("never enrols in a journey that was never published, or another launch's", async () => {
    const w = await world();
    const draft = { ...w.journey, status: "draft" as const };
    const ada = seedSignup(w.db, "ada");
    expect(
      await enrolWaitlistSignup(system, { journey: draft, version: w.version, campaign: w.campaign, signup: ada, source: "trigger" }, { db: w.db }),
    ).toEqual({ outcome: "skipped", reason: "journey_not_live" });
    const other = { ...ada, campaignId: "camp2" };
    expect(await w.enrol(other)).toEqual({ outcome: "skipped", reason: "wrong_launch" });
  });

  it("never counts a person against a cap: enrolment always goes ahead", async () => {
    const w = await world();
    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { caps: { sendsPerDay: 1, enrolmentsPerDay: 1 } });
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    for (const p of ["ada", "grace", "lin"]) {
      const r = await enrolWaitlistSignup(system, { journey, version: w.version, campaign: w.campaign, signup: seedSignup(w.db, p), source: "trigger" }, { db: w.db, nowMs: T0 });
      expect(r.outcome).toBe("enrolled");
    }
  });
});

describe("backfilling a new launch's waitlist", () => {
  it("enrols the verified signups, resuming where it stopped", async () => {
    const w = await world();
    for (const p of ["ada", "grace", "lin", "noor"]) seedSignup(w.db, p);
    seedSignup(w.db, "omar", { status: "unverified" });
    // Each person takes two clock reads (the deadline check, then the enrolment).
    let now = T0;
    const clock = () => (now += 1000);
    const first = await backfillWaitlistJourney(system, { journey: w.journey, version: w.version, campaign: w.campaign }, { db: w.db, now: clock, deadlineAt: T0 + 4500 });
    expect(first).toEqual({ enrolled: 2, done: false });
    const rest = await backfillWaitlistJourney(system, { journey: w.journey, version: w.version, campaign: w.campaign }, { db: w.db, now: clock, deadlineAt: T0 + 60_000 });
    expect(rest).toEqual({ enrolled: 2, done: true });
    expect(await forTenant(system, w.db).waitlistEnrolments.find({})).toHaveLength(4);
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    expect(journey.backfill).toMatchObject({ status: "done", enrolled: 4 });
    expect(await backfillWaitlistJourney(system, { journey, version: w.version, campaign: w.campaign }, { db: w.db })).toEqual({ enrolled: 0, done: true });
  });
});

describe("the lifecycle tick", () => {
  it("drains waitlist journeys when their engine is on, in their own queue", async () => {
    const w = await world();
    await w.enrol(seedSignup(w.db, "ada"));
    const sends = sendStub();
    const result = await runLifecycleTick(
      { db: w.db, now: () => T0, send: sends.send, listTenants: async () => [{ id: TENANT_ID, region: "eu" } as never] },
      { product: false, waitlist: true },
    );
    expect(result.tenants).toBe(1);
    expect(result.waitlist).toMatchObject({ due: 1, outcomes: { sent: 1 } });
    expect(sends.sent.map((m) => m.to)).toEqual(["ada@example.test"]);
  });

  it("uses one fixed journey id per launch", () => {
    expect(waitlistJourneyId(CAMPAIGN_ID)).toBe(waitlistJourneyId(CAMPAIGN_ID));
    expect(waitlistJourneyId(CAMPAIGN_ID)).not.toBe(waitlistJourneyId("camp2"));
    expect(waitlistJourneyId(CAMPAIGN_ID)).toMatch(/^lcjw_[0-9a-f]{40}$/);
  });
});
