import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import { METADATA_LIMIT_BYTES, fitMetadata, metadataBytes, type MandrillEvent } from "./mandrillWebhook";
import { attributionOfSend, readSendRef, readTenantTag, sendIdOf, sendMetadata, transactionalTag } from "./sends";

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
    expect(await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db })).toBe(longWaitlist);
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
      const meta = await sendMetadata(ctx, long as Record<string, string>, engine, { db });
      expect(Object.keys(meta)).toEqual(["t", "s"]);
      expect(metadataBytes(meta)).toBeLessThanOrEqual(90);
      expect(metadataBytes(meta)).toBeLessThanOrEqual(METADATA_LIMIT_BYTES);
    }
  });

  it("finds the same record when the same email is sent again, and keeps its attribution", async () => {
    const db = new FakeFirestore() as unknown as FirestoreLike;
    const a = await sendMetadata(ctx, longLifecycle, "lifecycle", { db });
    const b = await sendMetadata(ctx, longLifecycle, "lifecycle", { db });
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
    const a = await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db });
    expect(await attributionOfSend({ tenantId: "ten_other", region: "us", source: "system" }, a.s!, { db })).toBeNull();
    expect(await attributionOfSend({ ...ctx, source: "system" }, sendIdOf(LONGEST_TENANT, "evt:nothing"), { db })).toBeNull();
  });

  it("falls back to the long form when the record can't be written", async () => {
    const broken = { collection: () => ({ doc: () => ({}) }), runTransaction: async () => Promise.reject(new Error("down")) } as unknown as FirestoreLike;
    expect(await sendMetadata(ctx, longWaitlist, "waitlist_v2", { db: broken })).toBe(longWaitlist);
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
