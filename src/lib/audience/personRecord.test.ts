import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { recordEmailEvent } from "@/lib/email/events";
import { suppressEmailCategory } from "@/lib/email/suppression";
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
    expect(p.emailCounts).toEqual({ sent: 1, opened: 1, clicked: 0, tracked: 1 });
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

  it("finds nobody in another brand, and only when they were erased once they're gone", async () => {
    const w = await world();
    const other: TenantContext = { ...ctx, tenantId: "ten_other" };
    expect(await loadPersonRecord(other, w.user.id, { db: w.db })).toEqual({ found: false });
    expect(await loadPersonRecord(ctx, "pu_nobody", { db: w.db })).toEqual({ found: false });
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
