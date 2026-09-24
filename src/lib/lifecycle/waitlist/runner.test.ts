import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { EmailMessage, EmailResult } from "@/lib/email";
import { suppressionDocId } from "@/lib/email/suppression";
import { allocateVariant } from "@/lib/journey/allocation";
import type { Signup } from "@/lib/types/signup";
import type { WaitlistEnrolment } from "@/lib/types/lifecycle";
import { enrolUser } from "../enrol";
import { processEnrolment } from "../runner";
import { setLifecycleJourneyStatus } from "../service";
import { publishOnboarding, seedUser, sendStub } from "../testing/fixtures";
import { enrolWaitlistSignup, releaseHeldWaitlistEnrolments } from "./enrol";
import { waitlistEnrolmentId } from "./ids";
import { drainWaitlistTenant, processWaitlistEnrolment } from "./runner";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID, welcomeDraft } from "./testing/fixtures";

/**
 * Waitlist journeys on the lifecycle engine (engine move D2): the runner sends
 * as the original engine does, with the lifecycle engine's guarantees. Every
 * address is on example.test; sends go to a stub.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.stubEnv("LIFECYCLE_MODE_CEILING", "test");
});
afterEach(() => vi.unstubAllEnvs());

async function world(
  opts: {
    people?: string[];
    draft?: ReturnType<typeof welcomeDraft>;
    mode?: "test" | "shadow" | "live";
    shadowInbox?: string | null;
    testEmails?: string[];
    caps?: { sendsPerDay: number; enrolmentsPerDay: number };
    signup?: Partial<Omit<Signup, "id" | "tenantId">>;
  } = {},
) {
  const db = new FakeFirestore();
  seedLaunch(db);
  const people = (opts.people ?? ["ada"]).map((p) => seedSignup(db, p, opts.signup));
  const { journey, version } = await publishWaitlist(db, {
    draft: opts.draft,
    mode: opts.mode,
    shadowInbox: opts.shadowInbox,
    testEmails: opts.testEmails,
    caps: opts.caps,
  });
  const campaign = (await forTenant(system, db).campaigns.getById(CAMPAIGN_ID))!;
  for (const signup of people) {
    const r = await enrolWaitlistSignup(system, { journey, version, campaign, signup, source: "trigger" }, { db, nowMs: T0 });
    expect(r.outcome).toBe("enrolled");
  }
  let now = T0;
  let result: (m: EmailMessage) => EmailResult = () => ({ sent: true, provider: "mandrill", id: "m_1" });
  const sends = sendStub((m) => result(m));
  const weekly = vi.fn(async () => ({ ok: true }));
  const deps = { db, now: () => now, send: sends.send, syncWeekly: weekly };
  const idOf = (p = people[0]!) => waitlistEnrolmentId(journey.id, p.id);
  const enrolment = async (p = people[0]!) => (await forTenant(system, db).waitlistEnrolments.getById(idOf(p)))!;
  const run = (p = people[0]!) => processWaitlistEnrolment(system, idOf(p), deps);
  return {
    db,
    journey,
    version,
    campaign,
    people,
    sent: sends.sent,
    weekly,
    deps,
    idOf,
    enrolment,
    run,
    setNow: (ms: number) => (now = ms),
    setResult: (r: (m: EmailMessage) => EmailResult) => (result = r),
  };
}

describe("waitlist journeys on the lifecycle engine", () => {
  it("sends the welcome at once, as the original engine does, then the next email a day after the previous step", async () => {
    const w = await world();
    expect(await w.run()).toBe("sent");
    expect(w.sent).toHaveLength(1);
    const m = w.sent[0]!;
    expect(m.to).toBe("ada@example.test");
    expect(m.subject).toBe("Welcome to Fernlight");
    expect(m.html).toContain("Hi Ada, you&#39;re #1.");
    expect(m.html).toContain("https://cdn.example.test/hero.png");
    expect(m.fromEmail).toBe("jez@sandbox.test");
    expect(m.track).toEqual({ opens: true, clicks: true });
    expect(m.tags).toEqual(["journey", "node-email1"]);
    expect(m.metadata).toMatchObject({ tenantId: TENANT_ID, campaignId: CAMPAIGN_ID, journeyId: w.journey.id, nodeId: "email1", signupId: "ada", variantId: "control", recipientKind: "signup" });
    expect(m.listUnsubscribe?.url).toMatch(/^https:\/\/mk\.test\/api\/unsubscribe\?u=/);

    const e = await w.enrolment();
    expect(e.cursor?.nodeId).toBe("cond1");
    expect(e.nextRunAt).toBe(iso(T0 + 24 * HOUR));
    const events = await forTenant(system, w.db).emailEvents.find({ where: [["journeyId", "==", w.journey.id]] });
    expect(events.map((x) => [x.type, x.campaignId, x.recipientKind, x.nodeId])).toEqual([["send", CAMPAIGN_ID, "signup", "email1"]]);

    // A day later: hasn't used the voice chat (missing = hasn't, as on the original engine) → the nudge.
    w.setNow(T0 + 24 * HOUR);
    expect(await w.run()).toBe("sent");
    expect(w.sent.map((x) => x.subject)).toEqual(["Welcome to Fernlight", "Try the voice chat"]);
    expect((await w.enrolment()).status).toBe("completed");
  });

  it("reads signup.* conditions like the original engine (someone who used the voice chat gets the other branch)", async () => {
    const w = await world({ signup: { aiConversation: { completed: true } } as Partial<Signup> });
    await w.run();
    w.setNow(T0 + 24 * HOUR);
    await w.run();
    expect(w.sent.map((x) => x.subject)).toEqual(["Welcome to Fernlight", "Thanks for chatting"]);
  });

  it("sends once when two runs race", async () => {
    const w = await world();
    const outcomes = await Promise.all([w.run(), w.run()]);
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it("records a send interrupted by a crash as unknown and never resends it", async () => {
    const w = await world();
    await forTenant(system, w.db).waitlistEnrolments.update(w.idOf(), {
      pendingSend: { nodeId: "email1", poolId: "p_email1", itemId: "control", at: iso(T0) },
    });
    expect(await w.run()).toBe("waiting");
    expect(w.sent).toHaveLength(0);
    const e = await w.enrolment();
    expect(e.sentItems).toMatchObject([{ nodeId: "email1", status: "unknown", reason: "interrupted" }]);
    expect(e.cursor?.nodeId).toBe("cond1");
  });

  it("records an ambiguous provider answer as unknown and moves on", async () => {
    const w = await world();
    w.setResult(() => ({ sent: false, provider: "mandrill", reason: "timeout", ambiguous: true }));
    expect(await w.run()).toBe("sent");
    expect((await w.enrolment()).sentItems).toMatchObject([{ status: "unknown" }]);
  });

  it("retries a definite failure later and gives the day's slot back", async () => {
    const w = await world();
    w.setResult(() => ({ sent: false, provider: "mandrill", reason: "rejected" }));
    expect(await w.run()).toBe("failed");
    const e = await w.enrolment();
    expect(e.failures).toBe(1);
    expect(e.cursor?.nodeId).toBe("email1");
    const counter = await forTenant(system, w.db).lifecycleCounters.getById(`${w.journey.id}_20260921`);
    expect(counter?.sends).toBe(0);
  });

  it("parks people while the journey is paused, still enrols newcomers, and releases everyone on resume", async () => {
    const w = await world();
    const paused = await setLifecycleJourneyStatus(system, w.journey.id, "paused", { db: w.db, nowMs: T0 });
    expect(paused.ok).toBe(true);
    expect(await w.run()).toBe("held");
    let e = await w.enrolment();
    expect(e).toMatchObject({ status: "active", nextRunAt: null, heldReason: "journey_paused" });
    expect(w.sent).toHaveLength(0);

    // A newcomer joins the paused journey and waits (owner decision 1).
    const grace = seedSignup(w.db, "grace");
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    const r = await enrolWaitlistSignup(system, { journey, version: w.version, campaign: w.campaign, signup: grace, source: "trigger" }, { db: w.db, nowMs: T0 });
    expect(r).toMatchObject({ outcome: "enrolled", held: true });
    expect((await drainWaitlistTenant(system, w.deps)).due).toBe(0);

    w.setNow(T0 + HOUR);
    const resumed = await setLifecycleJourneyStatus(system, w.journey.id, "active", { db: w.db, nowMs: T0 + HOUR });
    expect(resumed.ok && resumed.value.released).toEqual({ released: 2, expired: 0 });
    e = await w.enrolment();
    expect(e).toMatchObject({ heldReason: null, nextRunAt: iso(T0 + HOUR) });
    const drained = await drainWaitlistTenant(system, w.deps);
    expect(drained.outcomes.sent).toBe(2);
    expect(w.sent.map((m) => m.to).sort()).toEqual(["ada@example.test", "grace@example.test"]);
  });

  it("lets people held for more than 90 days leave on resume", async () => {
    const w = await world();
    await setLifecycleJourneyStatus(system, w.journey.id, "paused", { db: w.db, nowMs: T0 });
    await w.run();
    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { status: "active" });
    const summary = await releaseHeldWaitlistEnrolments(system, { id: w.journey.id, status: "active" }, { db: w.db, now: T0 + 91 * DAY });
    expect(summary).toEqual({ released: 0, expired: 1 });
    expect(await w.enrolment()).toMatchObject({ status: "exited", stopReason: "hold_expired" });
  });

  it("parks people while the launch is archived, and won't resume or publish it until it's restored", async () => {
    const w = await world();
    await forTenant(system, w.db).campaigns.update(CAMPAIGN_ID, { archivedAt: iso(T0) });
    expect(await w.run()).toBe("held");
    expect(await w.enrolment()).toMatchObject({ heldReason: "launch_archived", nextRunAt: null });
    await setLifecycleJourneyStatus(system, w.journey.id, "paused", { db: w.db, nowMs: T0 });
    const resumed = await setLifecycleJourneyStatus(system, w.journey.id, "active", { db: w.db, nowMs: T0 });
    expect(resumed).toMatchObject({ ok: false, status: 409, error: "launch_archived" });
  });

  it("holds everyone while the kill switch is off, touching nothing, and carries on when it's back on", async () => {
    const w = await world();
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "false");
    const before = await w.enrolment();
    expect(await w.run()).toBe("held");
    expect(await drainWaitlistTenant(system, w.deps)).toEqual({ due: 0, outcomes: {}, deferred: 0 });
    expect(await w.enrolment()).toEqual(before);
    expect(w.sent).toHaveLength(0);
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
    expect(await w.run()).toBe("sent");
  });

  it("sends live with the prod ceiling at test, while a product journey stays held", async () => {
    const w = await world();
    expect(await w.run()).toBe("sent");
    expect(w.sent[0]!.to).toBe("ada@example.test");

    const { journey, version } = await publishOnboarding(w.db, { mode: "live" });
    const user = seedUser(w.db, "alex");
    const r = await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db: w.db, nowMs: T0 });
    expect(r.outcome).toBe("enrolled");
    const productSends = sendStub();
    const outcome = await processEnrolment(system, r.outcome === "enrolled" ? r.enrolmentId : "", {
      db: w.db,
      now: () => T0 + 15 * 60_000,
      send: productSends.send,
      fetchContext: async () => ({ ok: false, error: "timeout", latencyMs: 1 }),
    });
    expect(outcome).toBe("held");
    expect(productSends.sent).toHaveLength(0);
  });

  it("never drops anyone over the daily cap: the next person waits for tomorrow", async () => {
    const w = await world({ people: ["ada", "grace"], caps: { sendsPerDay: 1, enrolmentsPerDay: 1 } });
    expect(await w.run(w.people[0])).toBe("sent");
    expect(await w.run(w.people[1])).toBe("held");
    const e = await w.enrolment(w.people[1]);
    expect(e).toMatchObject({ status: "active", nextRunAt: "2026-09-22T00:00:00.000Z" });
    w.setNow(Date.parse("2026-09-22T00:00:00.000Z"));
    expect(await w.run(w.people[1])).toBe("sent");
  });

  it("stops for people who are unverified or unsubscribed, and removes a deleted person's enrolment", async () => {
    const w = await world({ people: ["ada", "grace", "lin"] });
    await forTenant(system, w.db).signups.update("ada", { status: "offboarded" });
    w.db.seed("email_suppressions", suppressionDocId(TENANT_ID, "grace@example.test"), { tenantId: TENANT_ID, email: "grace@example.test", reason: "unsubscribe" });
    await forTenant(system, w.db).signups.delete("lin");
    expect(await w.run(w.people[0])).toBe("exited");
    expect(await w.run(w.people[1])).toBe("exited");
    expect(await w.run(w.people[2])).toBe("exited");
    expect((await w.enrolment(w.people[0])).stopReason).toBe("not_verified");
    expect((await w.enrolment(w.people[1])).stopReason).toBe("unsubscribed");
    expect(await forTenant(system, w.db).waitlistEnrolments.getById(w.idOf(w.people[2]))).toBeNull();
    expect(w.sent).toHaveLength(0);
  });

  it("stops for someone the original engine emails", async () => {
    const w = await world();
    await forTenant(system, w.db).signups.update("ada", { journeyEngine: "legacy" });
    expect(await w.run()).toBe("exited");
    expect((await w.enrolment()).stopReason).toBe("on_original_engine");
    expect(w.sent).toHaveLength(0);
  });

  it("gives each person the same A/B arm as the original engine, and everyone the promoted winner", async () => {
    const people = ["ada", "grace", "lin", "noor", "omar", "priya", "quinn", "rosa"];
    const w = await world({ people, draft: welcomeDraft({ abTest: { splitPercent: 50 } }) });
    for (const p of w.people) await w.run(p);
    const legacy = { enabled: true, status: "running" as const, splitPercent: 50, variants: [{ variantId: "var_b", subject: "", body: "" }] };
    for (const [i, p] of w.people.entries()) {
      const expected = allocateVariant("email1", p.id, legacy).variantId;
      expect(w.sent[i]!.metadata?.variantId).toBe(expected);
    }
    expect(new Set(w.sent.map((m) => m.metadata?.variantId))).toEqual(new Set(["control", "var_b"]));

    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { abWinners: { p_email1: "var_b" } });
    const late = seedSignup(w.db, "sam");
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    await enrolWaitlistSignup(system, { journey, version: w.version, campaign: w.campaign, signup: late, source: "trigger" }, { db: w.db, nowMs: T0 });
    await w.run(late);
    expect(w.sent.at(-1)!.metadata?.variantId).toBe("var_b");
  });

  it("hands people to the weekly newsletter at a weekly exit", async () => {
    const w = await world({ draft: welcomeDraft({ exitTarget: "weekly" }) });
    await w.run();
    w.setNow(T0 + 24 * HOUR);
    await w.run();
    expect(w.weekly).toHaveBeenCalledTimes(1);
    expect((await w.enrolment()).status).toBe("completed");
  });

  it("rehearses in shadow: only the shadow inbox gets mail, with no unsubscribe token or attribution, and nobody is stamped", async () => {
    const w = await world({ people: [] });
    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { shadowInbox: "jez@sandbox.test" });
    const journey = (await forTenant(system, w.db).lifecycleJourneys.getById(w.journey.id))!;
    const ada = seedSignup(w.db, "ada", { journeyEngine: "legacy" });
    const r = await enrolWaitlistSignup(system, { journey, version: w.version, campaign: w.campaign, signup: ada, source: "backfill", rehearsal: true }, { db: w.db, nowMs: T0 });
    expect(r.outcome).toBe("enrolled");
    const id = r.outcome === "enrolled" ? r.enrolmentId : "";
    expect(await processWaitlistEnrolment(system, id, w.deps)).toBe("sent");
    const m = w.sent[0]!;
    expect(m.to).toBe("jez@sandbox.test");
    expect(m.listUnsubscribe).toBeUndefined();
    expect(m.metadata).toBeUndefined();
    expect(m.tags).toEqual(["lifecycle-shadow"]);
    expect((await forTenant(system, w.db).signups.getById("ada"))!.journeyEngine).toBe("legacy");
    expect(await forTenant(system, w.db).emailEvents.find({})).toHaveLength(0);
  });

  it("keeps the enrolment's version when the journey is republished", async () => {
    const w = await world();
    const e: WaitlistEnrolment = await w.enrolment();
    expect(e.versionId).toBe(w.version.id);
  });
});
