import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import { METADATA_LIMIT_BYTES, fitMetadata, metadataBytes, type MandrillEvent } from "./mandrillWebhook";
import { attributionOfSend, readSendRef, readTenantTag, sendIdOf, sendMetadata, transactionalTag } from "./sends";
import { personIdForAddress } from "@/lib/ontology/personRef";
import type { CountBuffer } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";

/** What made the email, as every sender must say (learning loops step 5): words a person wrote. */
const SENT_BY_PERSON = { made: { unstamped: "person_wrote" }, kind: "journeys" } as const;

// Made-up brand and people. The longest ids the app makes: tenant `ten_` + 40, launch slugs of 60,
// canvas node `email_<uuid>`, signup/enrolment/product user `xxx_` + 40.
const LONGEST_TENANT = `ten_${"a".repeat(40)}`;
const ctx = { tenantId: LONGEST_TENANT, region: "us" as const };
const longWaitlist = {
  tenantId: LONGEST_TENANT,
  campaignId: "c".repeat(60),
  journeyId: `lcjw_${"j".repeat(40)}`,
  nodeId: `email_${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`,
  signupId: `sig_${"s".repeat(40)}`,
  variantId: "v".repeat(40),
  recipientKind: "signup",
};
const longLifecycle = {
  tenantId: LONGEST_TENANT,
  journeyId: `lcj_${"j".repeat(40)}`,
  nodeId: "n".repeat(64),
  signupId: `pu_${"p".repeat(40)}`,
  variantId: "v".repeat(40),
  campaignId: "",
  recipientKind: "product_user",
  connectionId: `pcn_${"c".repeat(40)}`,
};
const ev = (metadata: Record<string, string> | undefined): MandrillEvent => ({ event: "open", msg: { metadata } }) as MandrillEvent;

describe("sendMetadata", () => {
  beforeEach(() => vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("sends the long form exactly as before while the switch is off", async () => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "false");
    const db = new FakeFirestore() as unknown as FirestoreLike;
    expect(await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db, ...SENT_BY_PERSON })).toBe(longWaitlist);
  });

  it("the long forms can go over Mandrill's limit, which is why the short one exists", () => {
    expect(metadataBytes(longWaitlist)).toBeGreaterThan(METADATA_LIMIT_BYTES);
    expect(metadataBytes(longLifecycle)).toBeGreaterThan(METADATA_LIMIT_BYTES);
  });

  it("writes a send record and returns {t, s}, well under the limit at the longest ids, for every engine", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    for (const [long, engine] of [
      [longWaitlist, "waitlist_v2"],
      [{ ...longWaitlist, recipientKind: "" }, "waitlist"],
      [{ ...longWaitlist, nodeId: `wave_${"w".repeat(40)}`, variantId: "control" }, "invite"],
      [longLifecycle, "lifecycle"],
    ] as const) {
      const meta = await sendMetadata(ctx, long as Record<string, string>, engine, { db, ...SENT_BY_PERSON });
      expect(Object.keys(meta)).toEqual(["t", "s"]);
      expect(metadataBytes(meta)).toBeLessThanOrEqual(90);
      expect(metadataBytes(meta)).toBeLessThanOrEqual(METADATA_LIMIT_BYTES);
    }
  });

  it("finds the same record when the same email is sent again, and keeps its attribution", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    const a = await sendMetadata(ctx, longLifecycle, "lifecycle", { db, ...SENT_BY_PERSON });
    const b = await sendMetadata(ctx, longLifecycle, "lifecycle", { db, ...SENT_BY_PERSON });
    expect(a).toEqual(b);
    const meta = await attributionOfSend({ ...ctx, source: "system" }, a.s!, { db });
    expect(meta).toEqual({
      tenantId: LONGEST_TENANT,
      campaignId: "",
      journeyId: longLifecycle.journeyId,
      nodeId: longLifecycle.nodeId,
      signupId: longLifecycle.signupId,
      variantId: longLifecycle.variantId,
      recipientKind: "product_user",
      connectionId: longLifecycle.connectionId,
    });
  });

  it("gives another brand's record nothing, and an erased record null", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    const a = await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db, ...SENT_BY_PERSON });
    expect(await attributionOfSend({ tenantId: "ten_other", region: "us", source: "system" }, a.s!, { db })).toBeNull();
    expect(await attributionOfSend({ ...ctx, source: "system" }, sendIdOf(LONGEST_TENANT, "evt:nothing"), { db })).toBeNull();
  });

  it("counts records_off for a stamped email with no record to keep its stamp, and nothing for one with no stamp", async () => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "false");
    vi.stubEnv("LOOPS_ENABLED", "true");
    const unstamped = vi.fn();
    const counts = { unstamped } as unknown as CountBuffer;
    const db = new FakeFirestore() as unknown as FirestoreLike;
    const stamp = (await learnedFor({ ...ctx, source: "system" }, "send_time")).stamp;
    expect(await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db, made: stamp, kind: "send_time", counts })).toBe(longWaitlist);
    expect(unstamped).toHaveBeenCalledWith(expect.objectContaining({ tenantId: LONGEST_TENANT }), "send_time", "records_off");
    unstamped.mockClear();
    await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db, ...SENT_BY_PERSON, counts });
    expect(unstamped).not.toHaveBeenCalled();
  });

  it("falls back to the long form when the record can't be written", async () => {
    const broken = { collection: () => ({ doc: () => ({}) }), runTransaction: async () => Promise.reject(new Error("down")) } as unknown as FirestoreLike;
    expect(await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db: broken, ...SENT_BY_PERSON })).toBe(longWaitlist);
  });
});

describe("the person on a send record (ONTOLOGY_PERSON_IDS_ENABLED)", () => {
  const PERSON = personIdForAddress(LONGEST_TENANT, "ada@example.com")!;
  beforeEach(() => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is kept on the record, never in the metadata Mandrill gets, which stays under its limit", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as FirestoreLike;
    for (const [long, engine] of [
      [longWaitlist, "waitlist_v2"],
      [longLifecycle, "lifecycle"],
    ] as const) {
      const meta = await sendMetadata(ctx, long as Record<string, string>, engine, { db, personId: PERSON, ...SENT_BY_PERSON });
      expect(Object.keys(meta)).toEqual(["t", "s"]);
      expect(JSON.stringify(meta)).not.toContain(PERSON);
      expect(metadataBytes(meta)).toBeLessThanOrEqual(METADATA_LIMIT_BYTES);
      expect(fake.raw("email_sends", meta.s!)?.personId).toBe(PERSON);
      expect((await attributionOfSend({ ...ctx, source: "system" }, meta.s!, { db }))?.personId).toBe(PERSON);
    }
  });

  it("is never written into the long form either, when the record can't be written", async () => {
    vi.stubEnv("EMAIL_SEND_RECORDS_ENABLED", "false");
    const meta = await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db: new FakeFirestore() as unknown as FirestoreLike, personId: PERSON, ...SENT_BY_PERSON });
    expect(meta).toBe(longWaitlist);
    expect(JSON.stringify(meta)).not.toContain("ct_");
  });

  it("is only written on a new record: a record already there keeps what it has", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as FirestoreLike;
    const first = await sendMetadata(ctx, longLifecycle, "lifecycle", { db, ...SENT_BY_PERSON });
    await sendMetadata(ctx, longLifecycle, "lifecycle", { db, personId: PERSON, ...SENT_BY_PERSON });
    expect(fake.raw("email_sends", first.s!)).not.toHaveProperty("personId");
  });

  it("is not written while the switch is off", async () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    const fake = new FakeFirestore();
    const meta = await sendMetadata(ctx, longLifecycle, "lifecycle", { db: fake as unknown as FirestoreLike, personId: PERSON, ...SENT_BY_PERSON });
    expect(fake.raw("email_sends", meta.s!)).not.toHaveProperty("personId");
    expect((await attributionOfSend({ ...ctx, source: "system" }, meta.s!, { db: fake as unknown as FirestoreLike }))).not.toHaveProperty("personId");
  });
});

describe("reading the forms back", () => {
  it("tells {t, s} from the enrolment form and from the brand alone", () => {
    expect(readSendRef(ev({ t: "ten_a", s: sendIdOf("ten_a", "evt:x") }))).toEqual({ tenantId: "ten_a", sendId: sendIdOf("ten_a", "evt:x") });
    expect(readSendRef(ev({ t: "ten_a", e: "enr_1" }))).toBeNull();
    expect(readSendRef(ev({ t: "ten_a", s: "not-a-send-id" }))).toBeNull();
    expect(readTenantTag(ev({ t: "ten_a" }))).toBe("ten_a");
    expect(readTenantTag(ev(undefined))).toBe("");
  });

  it("keeps the brand when metadata would be over the limit, so bounces still suppress", () => {
    expect(fitMetadata({ t: "ten_a", s: "es_x" })).toEqual({ t: "ten_a", s: "es_x" });
    expect(fitMetadata(longWaitlist)).toEqual({ t: LONGEST_TENANT });
  });
});

describe("transactionalTag", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("adds the brand only while its switch is on", () => {
    expect(transactionalTag("ten_a")).toEqual({});
    vi.stubEnv("EMAIL_TRANSACTIONAL_TENANT_TAG_ENABLED", "true");
    expect(transactionalTag("ten_a")).toEqual({ metadata: { t: "ten_a" } });
    expect(transactionalTag("")).toEqual({});
  });
});

describe("summariseEmailSends", () => {
  it("counts delivered emails beside opens, clicks and bounces", async () => {
    const { summariseEmailSends } = await import("./sends");
    const { forTenant } = await import("@/lib/tenant");
    const db = new FakeFirestore() as unknown as FirestoreLike;
    const repo = forTenant({ tenantId: "ten_a", region: "us", source: "system" }, db).emailSends;
    const base = { engine: "waitlist", campaignId: "c", journeyId: "j", nodeId: "n", variantId: "control", createdAt: "x", updatedAt: "x" };
    await repo.create("es_1", { ...base, signupId: "s1", deliveredAt: "2026-11-18T00:00:00Z", opens: { count: 3, firstAt: "", lastAt: "", mobile: 0, desktop: 0, clients: {} } } as never);
    await repo.create("es_2", { ...base, signupId: "s2", bounce: { kind: "hard", description: "", diag: "", at: "" } } as never);
    const { totals } = await summariseEmailSends({ tenantId: "ten_a", region: "us", source: "system" }, { journeyId: "j" }, db);
    expect(totals).toMatchObject({ sends: 2, delivered: 1, totalOpens: 3, hardBounces: 1 });
  });
});
