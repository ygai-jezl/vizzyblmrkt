import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { recordEmailEvent } from "@/lib/email/events";
import { suppressEmail, suppressEmailCategory } from "@/lib/email/suppression";
import { eraseProductUser } from "@/lib/connect/erase";
import { enrolUser, enrolmentDocId } from "@/lib/lifecycle/enrol";
import { processEnrolment } from "@/lib/lifecycle/runner";
import { CONNECTION_ID, STEPS, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "@/lib/lifecycle/testing/fixtures";
import { loadPersonRecord, loadPersonSummaries } from "./personRecord";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_SEND_TRACKING;
  delete process.env.LIFECYCLE_CONSENT_AT_SEND;
});

/** Alex, enrolled in the published onboarding journey, with the welcome sent. */
async function world(opts: { consent?: "consent" | "none" } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex", {
    signedUpAt: iso(T0),
    ...(opts.consent === "none" ? { consent: { basis: "none" as const, assertedBasis: "none" as const, source: null, at: iso(T0) } } : {}),
  });
  const { journey, version } = await publishOnboarding(db, { testUserIds: ["alex"] });
  await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  let now = T0;
  const sends = sendStub();
  const deps = { db, now: () => now, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext };
  const id = enrolmentDocId(journey.id, user.id);
  const run = (at: number) => {
    now = at;
    return processEnrolment(system, id, deps);
  };
  await run(T0);
  expect(await run(T0 + 15 * MIN)).toBe("sent");
  const enrolment = async () => (await forTenant(system, db).lifecycleEnrolments.getById(id))!;
  const person = async (nowMs: number) => {
    const r = await loadPersonRecord(ctx, user.id, { db, nowMs });
    if (!r.found) throw new Error("person not found");
    return r.person;
  };
  return { db, user, journey, sent: sends.sent, run, enrolment, person, id };
}

describe("loadPersonRecord", () => {
  it("gathers who they are, where they are and what they were sent", async () => {
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    const w = await world();
    const after = T0 + 20 * MIN;
    await recordEmailEvent(system, { campaignId: "", recipientKind: "product_user", connectionId: CONNECTION_ID, enrolmentId: w.id, journeyId: w.journey.id, nodeId: "email_welcome", signupId: w.user.id, variantId: "w", type: "open", ts: iso(after) }, w.db);
    const p = await w.person(after + MIN);

    expect(p).toMatchObject({ name: "Alex", email: "alex@customer.test", product: "Sandbox", externalUserId: "alex", signedUpAt: iso(T0), lastActiveAt: null });
    expect(p.stage).toMatchObject({ kind: "new", done: 0, total: STEPS.length, nextStep: "Add your brand" });
    expect(p.reach.can).toBe("yes");
    expect(p.steps.map((s) => [s.label, s.done])).toEqual(STEPS.map((s) => [s.label, false]));

    expect(p.emails).toHaveLength(1);
    expect(p.emails[0]).toMatchObject({
      label: "W · Welcome",
      subject: "Welcome to Sandbox, Alex",
      status: "sent",
      journeyName: "Onboarding",
      openedAt: iso(after),
      clickedAt: null,
      tracked: { opens: true, clicks: true },
    });
    expect(p.emailCounts).toEqual({ sent: 1, opened: 1, clicked: 0, tracked: 1, trackedClicks: 1 });
    expect(p.storyCut).toBe(false);
    // Already in the only journey, so there's nothing to add them to.
    expect(p.canJoin).toEqual([]);
    expect(p.timeline.map((m) => m.text)).toEqual(['Opened "Welcome to Sandbox, Alex"', 'Sent "Welcome to Sandbox, Alex"', "Entered Onboarding", "Signed up"]);
  });

  it("shows where they are in a journey, and what the sender does next", async () => {
    const w = await world();
    const e = await w.enrolment();
    const [j] = (await w.person(T0 + 30 * MIN)).journeys;
    expect(j).toMatchObject({ name: "Onboarding", status: "active", mode: "test", stopped: null, canRunNow: true });
    expect(j!.waiting).toEqual({ until: e.nextRunAt, why: null });
    expect(j!.steps[0]).toMatchObject({ kind: "sent", label: "W · Welcome", itemId: "w" });
    const next = j!.steps.find((s) => s.kind === "next")!;
    // Nothing done yet, so the first reminder is next, when their enrolment next runs.
    expect(next).toMatchObject({ label: "R1 · Next step", itemId: "r1", at: e.nextRunAt, personalised: true });
    expect(j!.steps.filter((s) => s.kind === "later").map((s) => s.itemId)).toEqual(["r2", "q", "l"]);
    expect(j!.then).toEqual({ kind: "finishes", why: null });

    // The prediction is the runner's own walk: it sends exactly that, then.
    expect(await w.run(Date.parse(e.nextRunAt!))).toBe("sent");
    expect((await w.enrolment()).sentItems[1]).toMatchObject({ itemId: next.itemId, nodeId: next.nodeId, at: next.at });
  });

  it("says a marketing email won't go out without consent, and why a journey stopped", async () => {
    process.env.LIFECYCLE_CONSENT_AT_SEND = "true";
    const w = await world({ consent: "none" });
    const p = await w.person(T0 + 30 * MIN);
    expect(p.reach).toMatchObject({ can: "limited", marketing: false });
    const ahead = p.journeys[0]!.steps.slice(1);
    expect(ahead.every((s) => s.kind === "would_skip" && s.reason === "No marketing consent")).toBe(true);

    // They opt out of the journey's category: the next run stops it, and the page says why.
    await suppressEmailCategory(system, { email: w.user.email!, category: "onboarding", source: "list-unsubscribe" }, w.db);
    expect(await w.run(Date.parse((await w.enrolment()).nextRunAt!))).toBe("exited");
    const stopped = await w.person(T0 + 3 * 86_400_000);
    expect(stopped.journeys[0]).toMatchObject({ status: "exited", stopped: "They unsubscribed from these emails", waiting: null, canRunNow: false });
    expect(stopped.reach.optedOutOf).toEqual(["onboarding"]);
    expect(stopped.optOuts.map((o) => o.text)).toEqual(["Opted out of Onboarding tips"]);
    expect(stopped.timeline.map((m) => m.text)).toContain("Left Onboarding");
  });

  describe("what the sender will do next is what it then does", () => {
    const journeys = (w: Awaited<ReturnType<typeof world>>) => forTenant(system, w.db).lifecycleJourneys;
    const users = (w: Awaited<ReturnType<typeof world>>) => forTenant(system, w.db).productUsers;
    /** The page before the next run, then that run, then the enrolment after it. */
    async function next(w: Awaited<ReturnType<typeof world>>) {
      const due = Date.parse((await w.enrolment()).nextRunAt!);
      const [before] = (await w.person(T0 + 30 * MIN)).journeys;
      const outcome = await w.run(due);
      return { before: before!, outcome, after: await w.enrolment(), due };
    }
    const ahead = (j: { steps: Array<{ kind: string }> }) => j.steps.filter((s) => s.kind === "next" || s.kind === "later" || s.kind === "would_skip");

    it.each([
      ["the journey is archived", (w) => journeys(w).update(w.journey.id, { status: "archived" }), "journey_archived", "the journey was archived"],
      ["they opt out in the product", (w) => users(w).update(w.user.id, { subscribed: false }), "unsubscribed_in_product", "they opted out in your product"],
      ["the product excludes them", (w) => users(w).update(w.user.id, { excluded: { reason: "internal account", at: iso(T0) } }), "excluded: internal account", "excluded by your product: internal account"],
      ["their address bounces", (w) => suppressEmail(system, { email: w.user.email!, reason: "hard_bounce", source: "mandrill-hard_bounce" }, w.db), "unsubscribed", "they unsubscribed from these emails"],
      ["the connection is revoked", (w) => forTenant(system, w.db).productConnections.update(CONNECTION_ID, { status: "revoked" }), "connection_revoked", "the product's connection was revoked"],
    ] as Array<[string, (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>, string, string]>)("stops, promising no email, once %s", async (_name, change, reason, why) => {
      const w = await world();
      await change(w);
      const r = await next(w);
      expect(r.before.then).toEqual({ kind: "stops", why, atNextRun: true });
      expect(ahead(r.before)).toEqual([]);
      expect(r.outcome).toBe("exited");
      expect(r.after.stopReason).toBe(reason);
    });

    it("is held, promising no email, while the journey is paused, and says nothing stale once it resumes", async () => {
      const w = await world();
      await journeys(w).update(w.journey.id, { status: "paused" });
      const paused = await next(w);
      expect(paused.before).toMatchObject({ waiting: { why: "The journey is paused" }, then: null });
      expect(ahead(paused.before)).toEqual([]);
      expect(paused.outcome).toBe("held");
      // Resumed: the hold's log line is still the last one, and it's no longer true.
      await journeys(w).update(w.journey.id, { status: "active" });
      const [resumed] = (await w.person(paused.due + MIN)).journeys;
      expect(resumed!.waiting).toEqual({ until: paused.after.nextRunAt, why: null });
      expect(ahead(resumed!)[0]).toMatchObject({ kind: "next", itemId: "r1" });
    });

    it("is held while they have no address, or aren't a test recipient of a journey in test mode", async () => {
      const w = await world();
      await users(w).update(w.user.id, { email: null, emailNormalized: null });
      expect((await w.person(T0 + 30 * MIN)).journeys[0]).toMatchObject({ waiting: { why: "They have no email address" }, then: null });
      const blocked = await world();
      await journeys(blocked).update(blocked.journey.id, { testRecipients: { userIds: [], emails: [] } });
      const r = await next(blocked);
      expect(r.before.waiting?.why).toBe("The journey is in test mode and they aren't a test recipient");
      expect(ahead(r.before)).toEqual([]);
      expect(r.outcome).toBe("held");
      expect(r.after.log.at(-1)?.event).toBe("mode_blocked");
    });

    it("shows what a run held it for only while that run is the last thing that happened", async () => {
      const w = await world();
      const repo = forTenant(system, w.db).lifecycleEnrolments;
      const e = await w.enrolment();
      const at = iso(T0 + 20 * MIN);
      await repo.update(w.id, { log: [...e.log, { at, event: "frequency_cap", detail: null }], updatedAt: at });
      expect((await w.person(T0 + 30 * MIN)).journeys[0]!.waiting?.why).toBe("They had another email in the last 20 hours");
      // A later run that only booked a wait writes no log line: the hold is over.
      await repo.update(w.id, { updatedAt: iso(T0 + 3 * 3600_000) });
      expect((await w.person(T0 + 4 * 3600_000)).journeys[0]!.waiting?.why).toBeNull();
    });

    it("runs by hand only while its emails go out in test or shadow mode", async () => {
      const w = await world();
      const repo = forTenant(system, w.db).lifecycleEnrolments;
      await repo.update(w.id, { mode: "live" });
      // The entry says live, the journey is still in test: test is how its emails go out.
      expect((await w.person(T0 + 30 * MIN)).journeys[0]).toMatchObject({ mode: "test", canRunNow: true });
      await journeys(w).update(w.journey.id, { deliveryMode: "live" });
      expect((await w.person(T0 + 30 * MIN)).journeys[0]).toMatchObject({ mode: "live", canRunNow: false });
    });
  });

  it("names a journey the product's own list doesn't reach, and says when their story is longer than the page", async () => {
    const w = await world();
    // The journey sits with another connection now: it is still found by its id, not shown as deleted.
    await forTenant(system, w.db).lifecycleJourneys.update(w.journey.id, { connectionId: "pcn_elsewhere" });
    const [row] = await loadPersonSummaries(ctx, [w.user.id], { db: w.db, nowMs: T0 + 30 * MIN });
    expect(row!.journey?.name).toBe("Onboarding");
    expect((await w.person(T0 + 30 * MIN)).journeys[0]!.name).toBe("Onboarding");

    for (let i = 0; i < 500; i += 1) {
      w.db.seed("product_events", `pe_${i}`, { tenantId: system.tenantId, connectionId: CONNECTION_ID, productUserId: w.user.id, externalUserId: "alex", messageId: `m_${i}`, type: "track", event: "report.created", payload: {}, timestamp: iso(T0 + i * MIN), receivedAt: iso(T0 + i * MIN), applied: true });
    }
    expect((await w.person(T0 + 30 * MIN)).storyCut).toBe(true);
  });

  it("finds nobody in another brand, and only when they were erased once they're gone", async () => {
    const w = await world();
    const other: TenantContext = { ...ctx, tenantId: "ten_other" };
    expect(await loadPersonRecord(other, w.user.id, { db: w.db })).toEqual({ found: false });
    expect(await loadPersonRecord(ctx, "pu_nobody", { db: w.db })).toEqual({ found: false });
    // An id that could never be one of ours is nobody, not an error.
    expect(await loadPersonRecord(ctx, "pu_a/b", { db: w.db })).toEqual({ found: false });
    expect(await loadPersonSummaries(ctx, ["pu_a/b", ""], { db: w.db })).toEqual([]);
    await eraseProductUser(ctx, CONNECTION_ID, w.user.id, w.db, T0 + 86_400_000);
    expect(await loadPersonRecord(ctx, w.user.id, { db: w.db })).toEqual({ found: false, erasedAt: iso(T0 + 86_400_000) });
  });
});

describe("loadPersonSummaries", () => {
  it("gives each row on screen its journey, emails and reach", async () => {
    const w = await world();
    const quiet = seedUser(w.db, "sam", { email: null, emailNormalized: null });
    const e = await w.enrolment();
    const rows = await loadPersonSummaries(ctx, [w.user.id, quiet.id, "pu_nobody"], { db: w.db, nowMs: T0 + 30 * MIN });
    expect(rows.map((r) => r.id)).toEqual([w.user.id, quiet.id]);
    expect(rows[0]).toMatchObject({
      journey: { name: "Onboarding", status: "active", sent: 1, next: { label: "R1 · Next step", at: e.nextRunAt }, note: null },
      activeJourneys: 1,
      emails: { sent: 1, opened: 0, clicked: 0 },
      reach: { can: "yes" },
    });
    expect(rows[1]).toMatchObject({ journey: null, activeJourneys: 0, emails: { sent: 0 }, reach: { can: "no", blocked: "no_address" } });
  });
});
