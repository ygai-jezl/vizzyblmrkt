import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { enrolmentSendMetadata, mandrillSignedData, type EventMetadata } from "@/lib/email/mandrillWebhook";
import { personIdForAddress } from "@/lib/ontology/personRef";
import type { ContactPersonId } from "@/lib/ontology/person";

const recordEmailEvent = vi.fn(async () => "recorded" as const);
const suppressEmail = vi.fn(async () => undefined);
const notifyProductOfSuppression = vi.fn(async () => undefined);
const attributionOfEnrolmentSend = vi.fn<(...a: unknown[]) => Promise<EventMetadata | null>>(async () => null);
vi.mock("@/lib/tenant", () => ({ getTenantById: async (id: string) => (id === "ten_a" ? { id, region: "eu" } : null) }));
vi.mock("@/lib/email/events", () => ({ recordEmailEvent: (...a: unknown[]) => recordEmailEvent(...(a as [])) }));
vi.mock("@/lib/email/suppression", () => ({ suppressEmail: (...a: unknown[]) => suppressEmail(...(a as [])) }));
vi.mock("@/lib/connect/suppressed", () => ({ notifyProductOfSuppression: (...a: unknown[]) => notifyProductOfSuppression(...(a as [])) }));
vi.mock("@/lib/lifecycle/sendAttribution", () => ({ attributionOfEnrolmentSend: (...a: unknown[]) => attributionOfEnrolmentSend(...a) }));
const attributionOfSend = vi.fn<(...a: unknown[]) => Promise<EventMetadata | null>>(async () => null);
vi.mock("@/lib/email/sends", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/sends")>()),
  attributionOfSend: (...a: unknown[]) => attributionOfSend(...a),
}));

const { POST } = await import("./route");

const KEY = "test-webhook-key";
const URL_ = "https://mk.test/api/webhooks/mandrill";

/** A batch as Mandrill posts it: form-encoded, signed over the registered URL. */
function post(events: unknown[]): Request {
  const body = new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
  const signature = createHmac("sha1", KEY).update(mandrillSignedData(URL_, body), "utf8").digest("base64");
  return new Request(URL_, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-mandrill-signature": signature }, body });
}

const LONG = { tenantId: "ten_a", journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", variantId: "a", campaignId: "", recipientKind: "product_user", connectionId: "pcn_1" };
const NAMED = enrolmentSendMetadata({ tenantId: "ten_a", enrolmentId: "enr_1", nodeId: "email_1", variantId: "a" });
const FOUND: EventMetadata = { ...LONG, recipientKind: "product_user", enrolmentId: "enr_1" };

describe("POST /api/webhooks/mandrill", () => {
  beforeEach(() => {
    process.env.MANDRILL_WEBHOOK_KEY = KEY;
    process.env.MANDRILL_WEBHOOK_URL = URL_;
    process.env.CONNECT_SUPPRESSION_WEBHOOK_ENABLED = "true";
    for (const fn of [recordEmailEvent, suppressEmail, notifyProductOfSuppression, attributionOfEnrolmentSend]) fn.mockClear();
    attributionOfEnrolmentSend.mockImplementation(async () => null);
  });
  afterEach(() => {
    for (const k of ["MANDRILL_WEBHOOK_KEY", "MANDRILL_WEBHOOK_URL", "CONNECT_SUPPRESSION_WEBHOOK_ENABLED"]) delete process.env[k];
  });

  it("records an email that carries its own attribution exactly as before, with no lookup", async () => {
    const res = await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "alex@customer.test", metadata: LONG } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 1, skipped: 0 });
    expect(attributionOfEnrolmentSend).not.toHaveBeenCalled();
    expect(recordEmailEvent).toHaveBeenCalledWith(
      { tenantId: "ten_a", region: "eu", source: "system" },
      { campaignId: "", journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", variantId: "a", recipientKind: "product_user", connectionId: "pcn_1", enrolmentId: null, type: "open", ts: new Date(1_790_000_000_000).toISOString(), mandrillMessageId: "m_1", url: null },
    );
  });

  it("puts an email that names its enrolment against that entry's journey, step and person, looked up once a batch", async () => {
    attributionOfEnrolmentSend.mockImplementation(async (_ctx, _ref, deps) => {
      const cache = (deps as { cache: Map<string, EventMetadata | null> }).cache;
      if (!cache.has("k")) cache.set("k", FOUND);
      return FOUND;
    });
    const msg = { _id: "m_1", email: "alex@customer.test", metadata: NAMED };
    const res = await POST(post([{ event: "open", ts: 1_790_000_000, msg }, { event: "click", ts: 1_790_000_060, url: "https://app.example.com/", msg }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 2, skipped: 0 });
    expect(attributionOfEnrolmentSend.mock.calls[0]![1]).toEqual({ tenantId: "ten_a", enrolmentId: "enr_1", nodeId: "email_1", variantId: "a" });
    // The same cache is handed to every event of the batch.
    expect((attributionOfEnrolmentSend.mock.calls[0]![2] as { cache: unknown }).cache).toBe((attributionOfEnrolmentSend.mock.calls[1]![2] as { cache: unknown }).cache);
    expect(recordEmailEvent.mock.calls.map((c) => (c as unknown[])[1])).toMatchObject([
      { journeyId: "lcj_1", nodeId: "email_1", signupId: "pu_1", connectionId: "pcn_1", enrolmentId: "enr_1", type: "open" },
      { enrolmentId: "enr_1", type: "click", url: "https://app.example.com/" },
    ]);
  });

  it("still stops emailing an address that bounced when its enrolment has gone, and tells the product when it hasn't", async () => {
    const bounce = { event: "hard_bounce", ts: 1_790_000_000, msg: { _id: "m_1", email: "alex@customer.test", metadata: NAMED } };
    // The person was erased: nobody to record it against, but the address still must not be emailed.
    let res = await POST(post([bounce]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect(recordEmailEvent).not.toHaveBeenCalled();
    expect(suppressEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_a" }), { email: "alex@customer.test", reason: "hard_bounce", source: "mandrill-hard_bounce", campaignId: null, signupId: null });
    expect(notifyProductOfSuppression).not.toHaveBeenCalled();

    // The enrolment is there, but the message couldn't say which email it was: the person is still known.
    attributionOfEnrolmentSend.mockImplementation(async () => ({ ...FOUND, nodeId: "" }));
    res = await POST(post([{ ...bounce, msg: { ...bounce.msg, metadata: { t: "ten_a", e: "enr_1" } } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect(recordEmailEvent).not.toHaveBeenCalled();
    expect(suppressEmail).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ email: "alex@customer.test", reason: "hard_bounce", signupId: "pu_1" }));
    expect(notifyProductOfSuppression).toHaveBeenCalledWith(expect.anything(), { connectionId: "pcn_1", productUserId: "pu_1", reason: "hard_bounce" });
  });

  it("skips an email that isn't ours, another brand's, or a request that isn't signed", async () => {
    const res = await POST(post([{ event: "open", msg: { email: "x@y.test" } }, { event: "hard_bounce", msg: { email: "x@y.test", metadata: { ...NAMED, t: "ten_unknown" } } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 2 });
    expect(suppressEmail).not.toHaveBeenCalled();
    const unsigned = new Request(URL_, { method: "POST", headers: { "x-mandrill-signature": "nope" }, body: "mandrill_events=%5B%5D" });
    expect((await POST(unsigned)).status).toBe(401);
  });
});

describe("POST /api/webhooks/mandrill with send records", () => {
  beforeEach(() => {
    process.env.MANDRILL_WEBHOOK_KEY = KEY;
    process.env.MANDRILL_WEBHOOK_URL = URL_;
    for (const fn of [recordEmailEvent, suppressEmail, attributionOfSend]) fn.mockClear();
  });
  afterEach(() => {
    for (const k of ["MANDRILL_WEBHOOK_KEY", "MANDRILL_WEBHOOK_URL"]) delete process.env[k];
  });

  const SEND = { t: "ten_a", s: "es_AAAAAAAAAAAAAAAAAAAAAA" };
  const ON_RECORD: EventMetadata = { tenantId: "ten_a", campaignId: "spring", journeyId: "lcjw_1", nodeId: "email_1", signupId: "sig_1", variantId: "control", recipientKind: "signup" };

  it("puts an email that names its send record against that record's journey, step and person", async () => {
    attributionOfSend.mockImplementation(async () => ON_RECORD);
    const res = await POST(post([{ event: "click", ts: 1_790_000_000, url: "https://app.example.com/", msg: { _id: "m_9", email: "sam@customer.test", metadata: SEND } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 1, skipped: 0 });
    expect(attributionOfSend.mock.calls[0]![1]).toBe("es_AAAAAAAAAAAAAAAAAAAAAA");
    expect((recordEmailEvent.mock.calls[0] as unknown[])[1]).toMatchObject({ campaignId: "spring", journeyId: "lcjw_1", nodeId: "email_1", signupId: "sig_1", type: "click", mandrillMessageId: "m_9" });
  });

  it("still suppresses a bounce when the send record has gone", async () => {
    attributionOfSend.mockImplementation(async () => null);
    const res = await POST(post([{ event: "hard_bounce", ts: 1_790_000_000, msg: { _id: "m_9", email: "sam@customer.test", metadata: SEND } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect(suppressEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_a" }), expect.objectContaining({ email: "sam@customer.test", reason: "hard_bounce" }));
  });

  it("suppresses a bounce on an email that names only its brand, and records nothing", async () => {
    const res = await POST(post([{ event: "spam", ts: 1_790_000_000, msg: { _id: "m_7", email: "sam@customer.test", metadata: { t: "ten_a" } } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect(recordEmailEvent).not.toHaveBeenCalled();
    expect(attributionOfSend).not.toHaveBeenCalled();
    expect(suppressEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_a" }), expect.objectContaining({ reason: "spam", campaignId: null, signupId: null }));
  });
});

describe("POST /api/webhooks/mandrill: the person on each event (ONTOLOGY_PERSON_IDS_ENABLED)", () => {
  const SIGNUP = { tenantId: "ten_a", campaignId: "spring", journeyId: "lcjw_1", nodeId: "email_1", signupId: "sig_1", variantId: "control", recipientKind: "signup" };
  const ENROLMENT_PERSON = personIdForAddress("ten_a", "kept@customer.test") as ContactPersonId;
  const call = () => (recordEmailEvent.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

  beforeEach(() => {
    vi.stubEnv("MANDRILL_WEBHOOK_KEY", KEY);
    vi.stubEnv("MANDRILL_WEBHOOK_URL", URL_);
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    for (const fn of [recordEmailEvent, suppressEmail, attributionOfSend, attributionOfEnrolmentSend]) fn.mockClear();
    attributionOfEnrolmentSend.mockImplementation(async () => null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("finds a sign-up's person from the address the email went to", async () => {
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "Sam@Customer.test", metadata: SIGNUP } }]));
    expect(call().personId).toBe(personIdForAddress("ten_a", "sam@customer.test"));
  });

  it("takes the person the enrolment holds for a product journey's email", async () => {
    attributionOfEnrolmentSend.mockImplementation(async () => ({ ...FOUND, personId: ENROLMENT_PERSON }));
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "alex@customer.test", metadata: NAMED } }]));
    expect(call().personId).toBe(ENROLMENT_PERSON);
  });

  it("takes the person the send record holds", async () => {
    attributionOfSend.mockImplementation(async () => ({ ...SIGNUP, recipientKind: "signup" as const, personId: ENROLMENT_PERSON }));
    await POST(post([{ event: "click", ts: 1_790_000_000, url: "https://app.example.com/", msg: { _id: "m_9", email: "sam@customer.test", metadata: { t: "ten_a", s: "es_AAAAAAAAAAAAAAAAAAAAAA" } } }]));
    expect(call().personId).toBe(ENROLMENT_PERSON);
  });

  it("never guesses a product user's person from the address", async () => {
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "alex@customer.test", metadata: LONG } }]));
    expect(call()).not.toHaveProperty("personId");
  });

  it("gives none while the switch is off", async () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    attributionOfEnrolmentSend.mockImplementation(async () => ({ ...FOUND, personId: ENROLMENT_PERSON }));
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "sam@customer.test", metadata: SIGNUP } }]));
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "alex@customer.test", metadata: NAMED } }]));
    for (const c of recordEmailEvent.mock.calls) expect((c as unknown[])[1]).not.toHaveProperty("personId");
  });
});
