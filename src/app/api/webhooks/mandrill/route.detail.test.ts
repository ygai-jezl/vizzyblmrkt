import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mandrillSignedData } from "@/lib/email/mandrillWebhook";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { EmailSend } from "@/lib/types/emailSend";
import { personIdForAddress } from "@/lib/ontology/personRef";

// The webhook with EMAIL_ENGAGEMENT_DETAIL_ENABLED: every open, click and bounce detail lands on
// the email's send record, through the real tenant layer on an in-memory database.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...real,
    getTenantById: async (id: string) => (id === "ten_a" ? { id, region: "us" } : null),
    forTenant: (ctx: Parameters<typeof real.forTenant>[0]) => real.forTenant(ctx, fake.db as FirestoreLike),
  };
});
vi.mock("@/lib/email/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/events")>()),
  recordEmailEvent: vi.fn(async () => "recorded"),
}));
vi.mock("@/lib/email/suppression", () => ({ suppressEmail: vi.fn(async () => undefined) }));

const { POST } = await import("./route");
const { sendIdOf } = await import("@/lib/email/sends");
const { emailEventKeyBase } = await import("@/lib/email/events");

const KEY = "test-webhook-key";
const URL_ = "https://mk.test/api/webhooks/mandrill";
function post(events: unknown[]): Request {
  const body = new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
  const signature = createHmac("sha1", KEY).update(mandrillSignedData(URL_, body), "utf8").digest("base64");
  return new Request(URL_, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-mandrill-signature": signature }, body });
}

const LONG = { tenantId: "ten_a", campaignId: "spring", journeyId: "lcjw_1", nodeId: "email_1", signupId: "sig_1", variantId: "control", recipientKind: "signup" };
const ID = sendIdOf("ten_a", emailEventKeyBase({ journeyId: "lcjw_1", nodeId: "email_1", signupId: "sig_1", variantId: "control" }));
const { forTenant } = await import("@/lib/tenant");
const read = async (): Promise<EmailSend | undefined> =>
  (await forTenant({ tenantId: "ten_a", region: "us", source: "system" }).emailSends.getById(ID)) ?? undefined;

describe("the webhook keeps every open, click and bounce detail", () => {
  beforeEach(() => {
    fake.db = new FakeFirestore();
    vi.stubEnv("MANDRILL_WEBHOOK_KEY", KEY);
    vi.stubEnv("MANDRILL_WEBHOOK_URL", URL_);
    vi.stubEnv("EMAIL_ENGAGEMENT_DETAIL_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("writes nothing to send records while the switch is off", async () => {
    vi.stubEnv("EMAIL_ENGAGEMENT_DETAIL_ENABLED", "false");
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "sam@customer.test", metadata: LONG } }]));
    expect(await read()).toBeUndefined();
  });

  it("makes a record for an email sent in the older form and counts every open and click on it", async () => {
    const msg = { _id: "m_1", email: "sam@customer.test", metadata: LONG };
    await POST(post([{ event: "open", ts: 1_790_000_000, msg }, { event: "open", ts: 1_790_000_100, msg }]));
    await POST(post([{ event: "click", ts: 1_790_000_200, url: "https://acme.test/pricing?x=1", msg }, { event: "open", ts: 1_790_000_100, msg }]));
    const s = await read();
    expect(s).toMatchObject({ tenantId: "ten_a", engine: "earlier", journeyId: "lcjw_1", signupId: "sig_1", mandrillMessageId: "m_1" });
    expect(s?.opens?.count).toBe(2);
    expect(s?.clicks).toMatchObject({ count: 1, links: [{ url: "https://acme.test/pricing", count: 1 }] });
  });

  it("writes a sign-up's person on a record it makes (ONTOLOGY_PERSON_IDS_ENABLED), and none with the switch off", async () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "Sam@Customer.test", metadata: LONG } }]));
    expect((await read())?.personId).toBe(personIdForAddress("ten_a", "sam@customer.test"));

    fake.db = new FakeFirestore();
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    await POST(post([{ event: "open", ts: 1_790_000_000, msg: { _id: "m_1", email: "sam@customer.test", metadata: LONG } }]));
    expect(await read()).toBeDefined();
    expect(await read()).not.toHaveProperty("personId");
  });

  it("keeps a delivery on the send without recording an event type for it", async () => {
    const res = await POST(post([{ event: "delivered", ts: 1_790_000_000, msg: { _id: "m_1", email: "sam@customer.test", metadata: LONG } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect((await read())?.deliveredAt).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it("keeps a deferral on the send without recording an event type for it", async () => {
    const res = await POST(post([{ event: "deferral", ts: 1_790_000_000, msg: { _id: "m_1", email: "sam@customer.test", metadata: LONG } }]));
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 1 });
    expect((await read())?.deferrals?.count).toBe(1);
  });
});
