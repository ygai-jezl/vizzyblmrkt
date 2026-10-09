import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { emailEventId, recordEmailEvent } from "@/lib/email/events";
import { METADATA_LIMIT_BYTES, enrolmentSendMetadata, metadataBytes, readEnrolmentSendRef, readEventMetadata } from "@/lib/email/mandrillWebhook";
import { attributionOfEnrolmentSend } from "./sendAttribution";
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
    // Exactly what it has always carried.
    expect(w.sent[0]!.metadata).toEqual({
      tenantId: system.tenantId,
      journeyId: w.journey.id,
      nodeId: "email_welcome",
      signupId: w.user.id,
      variantId: "w",
      campaignId: "",
      recipientKind: "product_user",
      connectionId: CONNECTION_ID,
    });
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
    // Named by its enrolment alone, so it fits what the provider keeps.
    expect(w.sent[0]!.metadata).toEqual({ t: system.tenantId, e: w.id, n: "email_welcome", v: "w" });
    expect(metadataBytes(w.sent[0]!.metadata!)).toBeLessThan(METADATA_LIMIT_BYTES);
    // The subject as Alex read it, not the template's tokens.
    expect((await w.enrolment()).sentItems[0]).toMatchObject({ itemId: "w", status: "sent", subject: "Welcome to Sandbox, Alex", tracked: ON });
    const rows = await forTenant(system, w.db).emailEvents.find({ where: [["signupId", "==", w.user.id]] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `evt:${w.journey.id}:email_welcome:${w.user.id}:w:${w.id}:send`, enrolmentId: w.id, type: "send" });

    // The provider sends an open back with that metadata: it lands on the same journey, step, person and entry.
    const ref = readEnrolmentSendRef({ event: "open", msg: { metadata: w.sent[0]!.metadata } })!;
    const meta = (await attributionOfEnrolmentSend(system, ref, { db: w.db }))!;
    expect(meta).toEqual({
      tenantId: system.tenantId,
      campaignId: "",
      journeyId: w.journey.id,
      nodeId: "email_welcome",
      signupId: w.user.id,
      variantId: "w",
      recipientKind: "product_user",
      connectionId: CONNECTION_ID,
      enrolmentId: w.id,
    });
    await recordEmailEvent(system, { ...meta, type: "open", ts: iso(T0 + 20 * MIN) }, w.db);
    const after = await forTenant(system, w.db).emailEvents.find({ where: [["signupId", "==", w.user.id]] });
    expect(after.map((r) => r.id).sort()).toEqual([
      `evt:${w.journey.id}:email_welcome:${w.user.id}:w:${w.id}:open`,
      `evt:${w.journey.id}:email_welcome:${w.user.id}:w:${w.id}:send`,
    ]);
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

  it("reads the long form as before, and never an enrolment from it", () => {
    const metadata = { tenantId: "ten_1", journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", variantId: "a", campaignId: "", recipientKind: "product_user", connectionId: "pcn_1" };
    expect(readEventMetadata({ event: "open", msg: { metadata } })).toEqual(metadata);
    expect(readEnrolmentSendRef({ event: "open", msg: { metadata } })).toBeNull();
    expect(readEnrolmentSendRef({ event: "open", msg: {} })).toBeNull();
  });
});

describe("a product journey email's metadata (the provider drops anything over 250 bytes)", () => {
  // Every id at its longest: a 40-character brand slug, a 64-character step id, a 40-character email id.
  const longest = { tenantId: `ten_${"b".repeat(40)}`, enrolmentId: `enr_${"a".repeat(40)}`, nodeId: "n".repeat(64), variantId: "v".repeat(40) };

  it("fits at every id's longest, where the long form doesn't fit a 20-character brand id", () => {
    const metadata = enrolmentSendMetadata(longest);
    expect(metadataBytes(metadata)).toBeLessThanOrEqual(METADATA_LIMIT_BYTES);
    expect(readEnrolmentSendRef({ event: "open", msg: { metadata } })).toEqual(longest);
    const longForm = { tenantId: "ten_fernlight-studio", journeyId: `lcj_${"j".repeat(20)}`, nodeId: "email_welcome", signupId: `pu_${"0".repeat(32)}`, variantId: "w", campaignId: "", recipientKind: "product_user", connectionId: `pcn_${"c".repeat(20)}` };
    expect(metadataBytes(longForm)).toBeGreaterThan(METADATA_LIMIT_BYTES);
  });

  it("gives up the step before the bounces: an id too long to carry leaves the tenant and the enrolment", () => {
    const metadata = enrolmentSendMetadata({ ...longest, nodeId: "é".repeat(64) });
    expect(metadata).toEqual({ t: longest.tenantId, e: longest.enrolmentId });
    expect(readEnrolmentSendRef({ event: "hard_bounce", msg: { metadata } })).toEqual({ tenantId: longest.tenantId, enrolmentId: longest.enrolmentId, nodeId: "", variantId: "" });
  });

  it("finds nobody once the enrolment has gone, or in another brand", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const user = seedUser(db, "alex");
    const { journey, version } = await publishOnboarding(db, { testUserIds: ["alex"] });
    await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
    const ref = { tenantId: system.tenantId, enrolmentId: enrolmentDocId(journey.id, user.id), nodeId: "email_welcome", variantId: "w" };
    expect(await attributionOfEnrolmentSend(system, ref, { db })).toMatchObject({ signupId: user.id, journeyId: journey.id });
    expect(await attributionOfEnrolmentSend({ ...system, tenantId: "ten_other" }, ref, { db })).toBeNull();
    expect(await attributionOfEnrolmentSend({ ...system, tenantId: "ten_other" }, { ...ref, tenantId: "ten_other" }, { db })).toBeNull();
    await forTenant(system, db).lifecycleEnrolments.delete(ref.enrolmentId);
    expect(await attributionOfEnrolmentSend(system, ref, { db })).toBeNull();
    // A step the message couldn't name: the person is still known.
    await enrolUser(system, { journey, version, user, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
    expect(await attributionOfEnrolmentSend(system, { ...ref, nodeId: "", variantId: "" }, { db })).toMatchObject({ signupId: user.id, nodeId: "" });
  });
});
