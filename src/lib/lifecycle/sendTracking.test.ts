import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { emailEventId } from "@/lib/email/events";
import { readEventMetadata } from "@/lib/email/mandrillWebhook";
import { enrolUser, enrolmentDocId } from "./enrol";
import { processEnrolment } from "./runner";
import { createLifecycleJourney, publishLifecycleJourney, saveLifecycleDraft } from "./service";
import { duplicateJourney } from "./transfer";
import { CONNECTION_ID, T0, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ON = { opens: true, clicks: true };
const OFF = { opens: false, clicks: false };

beforeEach(() => {
  process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
  process.env.LIFECYCLE_MODE_CEILING = "live";
});
afterEach(() => {
  delete process.env.EMAIL_LINK_ORIGIN;
  delete process.env.LIFECYCLE_MODE_CEILING;
  delete process.env.LIFECYCLE_SEND_TRACKING;
});

/** One test user enrolled in the published onboarding journey, ready to run. */
async function world(opts: { tracking?: typeof ON } = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  const user = seedUser(db, "alex");
  const { journey, version } = await publishOnboarding(db, { testUserIds: ["alex"], ...(opts.tracking ? { settings: { tracking: opts.tracking } } : {}) });
  expect((await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 })).outcome).toBe("enrolled");
  let now = T0;
  const sends = sendStub();
  const deps = { db, now: () => now, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext };
  const id = enrolmentDocId(journey.id, user.id);
  const run = (at: number) => {
    now = at;
    return processEnrolment(system, id, deps);
  };
  const enrolment = async () => (await forTenant(system, db).lifecycleEnrolments.getById(id))!;
  return { db, user, journey, sent: sends.sent, run, enrolment, id };
}

describe("opens and clicks for product journeys (LIFECYCLE_SEND_TRACKING)", () => {
  it("off: a journey tracks as its version was published, and a send keeps no subject", async () => {
    const w = await world();
    expect(w.journey.draft.settings.tracking).toEqual(OFF);
    expect(w.journey.tracking).toBeUndefined();
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    expect(w.sent[0]!.track).toEqual(OFF);
    expect(w.sent[0]!.metadata).not.toHaveProperty("enrolmentId");
    const sent = (await w.enrolment()).sentItems[0]!;
    expect(sent).not.toHaveProperty("subject");
    const rows = await forTenant(system, w.db).emailEvents.find({ where: [["signupId", "==", w.user.id]] });
    expect(rows.map((r) => r.id)).toEqual([`evt:${w.journey.id}:email_welcome:${w.user.id}:w:send`]);
  });

  it("on: a new product journey starts tracked, and each send names its enrolment and keeps its subject", async () => {
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    const w = await world();
    expect(w.journey.draft.settings.tracking).toEqual(ON);
    expect(w.journey.tracking).toEqual(ON);
    await w.run(T0);
    expect(await w.run(T0 + 15 * MIN)).toBe("sent");
    expect(w.sent[0]!.track).toEqual(ON);
    expect(w.sent[0]!.metadata).toMatchObject({ enrolmentId: w.id, recipientKind: "product_user" });
    // The subject as Alex read it, not the template's tokens.
    expect((await w.enrolment()).sentItems[0]).toMatchObject({ itemId: "w", status: "sent", subject: "Welcome to Sandbox, Alex", tracked: ON });
    const rows = await forTenant(system, w.db).emailEvents.find({ where: [["signupId", "==", w.user.id]] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `evt:${w.journey.id}:email_welcome:${w.user.id}:w:${w.id}:send`, enrolmentId: w.id, type: "send" });
  });

  it("on: switching tracking and publishing reaches someone already part-way through", async () => {
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    const w = await world({ tracking: OFF });
    expect(w.journey.tracking).toEqual(OFF);
    await w.run(T0);
    await w.run(T0 + 15 * MIN);
    expect(w.sent[0]!.track).toEqual(OFF);

    // Staff tick both boxes and publish: a new version, which Alex's enrolment isn't on.
    const repo = forTenant(ctx, w.db);
    const draft = (await repo.lifecycleJourneys.getById(w.journey.id))!.draft;
    expect((await saveLifecycleDraft(ctx, w.journey.id, { ...draft, settings: { ...draft.settings, tracking: ON } }, { db: w.db })).ok).toBe(true);
    const published = await publishLifecycleJourney(ctx, w.journey.id, { db: w.db });
    expect(published.ok && published.value.journey.tracking).toEqual(ON);
    const before = await w.enrolment();
    expect(before.versionId).toBe(`${w.journey.id}_v1`);

    expect(await w.run(Date.parse(before.nextRunAt!))).toBe("sent");
    expect(w.sent[1]!.track).toEqual(ON);
  });

  it("on: a journey published before the switch keeps its version's setting until it's published again", async () => {
    const w = await world(); // published with the switch off: no live setting on the journey
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    await w.run(T0);
    await w.run(T0 + 15 * MIN);
    expect(w.sent[0]!.track).toEqual(OFF);
  });

  it("on: a journey that continues from another keeps that journey's setting, and a copy keeps its own", async () => {
    process.env.LIFECYCLE_SEND_TRACKING = "true";
    process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED = "true";
    try {
      const db = new FakeFirestore();
      seedWorld(db);
      const { journey } = await publishOnboarding(db, { settings: { tracking: OFF } });
      const next = await createLifecycleJourney(ctx, { name: "After onboarding", connectionId: CONNECTION_ID, template: "follow_on", afterJourneyId: journey.id }, { db });
      expect(next.ok && next.value.journey.draft.settings.tracking).toEqual(OFF);

      const copy = await duplicateJourney(ctx, journey.id, { connectionId: CONNECTION_ID }, { db });
      expect(copy.ok).toBe(true);
      const copied = copy.ok ? await forTenant(ctx, db).lifecycleJourneys.getById(copy.value.journeyId) : null;
      expect(copied?.draft.settings.tracking).toEqual(OFF);
    } finally {
      delete process.env.LIFECYCLE_JOURNEY_LINKS_ENABLED;
    }
  });
});

describe("engagement rows per entry", () => {
  const base = { journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", variantId: "a", type: "open" as const };

  it("keeps the old key for a send that names no enrolment, and one per enrolment otherwise", () => {
    expect(emailEventId(base)).toBe("evt:lcj_1:email_1:pu_1:a:open");
    expect(emailEventId({ ...base, enrolmentId: null })).toBe("evt:lcj_1:email_1:pu_1:a:open");
    expect(emailEventId({ ...base, enrolmentId: "enr_first" })).toBe("evt:lcj_1:email_1:pu_1:a:enr_first:open");
    expect(emailEventId({ ...base, enrolmentId: "enr_second" })).not.toBe(emailEventId({ ...base, enrolmentId: "enr_first" }));
  });

  it("reads the enrolment from a lifecycle email's metadata", () => {
    const metadata = { tenantId: "ten_1", journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", variantId: "a", campaignId: "", recipientKind: "product_user", connectionId: "pcn_1" };
    expect(readEventMetadata({ event: "open", msg: { metadata: { ...metadata, enrolmentId: "enr_1" } } })).toMatchObject({ enrolmentId: "enr_1", connectionId: "pcn_1" });
    expect(readEventMetadata({ event: "open", msg: { metadata } })).not.toHaveProperty("enrolmentId");
    // A waitlist email never names one.
    expect(readEventMetadata({ event: "open", msg: { metadata: { ...metadata, recipientKind: "signup", enrolmentId: "enr_1" } } })).not.toHaveProperty("enrolmentId");
  });
});
