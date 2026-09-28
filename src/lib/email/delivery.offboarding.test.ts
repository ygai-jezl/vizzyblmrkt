import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The send is the output under test. The tenant registry would otherwise reach real
// Firestore, so it's stubbed (as delivery.ambiguous.test.ts does). Kept in a SEPARATE
// file so these module mocks don't disturb delivery.test.ts.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
const tenantRegistry = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => tenantRegistry.tenant) };
});

import { processEmailJobs } from "./delivery";
import { sendEmail } from "@/lib/email";
import { suppressEmail } from "./suppression";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * The offboarding email as it goes out today, pinned whole. A styled version is coming
 * behind a flag (EMAIL_STYLE_TRANSACTIONAL_ENABLED); with it off, this payload must not
 * change, even for a tenant with an Email style saved and the Email style flag on.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const send = sendEmail as unknown as ReturnType<typeof vi.fn>;

// A tenant with a verified sending domain and a saved Email style (a banner too).
const TENANT = {
  id: "ten_A",
  tenantName: "Example Co",
  region: "us",
  emailSenderConfig: {
    senderName: "Ada at Example",
    fromLocalPart: "ada",
    fromDomain: "example.com",
    replyTo: "ada@example.com",
    domains: [{ domain: "example.com", status: "verified" }],
  },
  emailStyle: {
    logo: { id: "logo_1", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png", width: 120, height: 40 },
    companyName: "Example Co",
    headerColor: "#0b1f3a",
    accentColor: "#ff6b35",
    headerImage: { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg", width: 1200, height: 300 },
  },
};

function job(id: string, payload: Record<string, unknown>) {
  return {
    tenantId: "ten_A",
    campaignId: "camp1",
    type: "lifecycle",
    status: "pending",
    dedupeKey: id,
    scheduledAt: "2020-01-01T00:00:00.000Z", // due
    attempts: 0,
    claimedAt: null,
    emailSentAt: null,
    payload,
    lastError: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    processedAt: null,
  };
}

function world(opts: { offboardingEmail?: Record<string, unknown>; locale?: string } = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("campaigns", "camp1", {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Example Beta",
    offboardingEmail: { enabled: true, ...opts.offboardingEmail },
  });
  db.seed("signups", "s1", {
    id: "s1",
    tenantId: "ten_A",
    campaignId: "camp1",
    status: "offboarded",
    verified: true,
    email: "maya@example.com",
    firstName: "Maya",
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  db.seed("email_jobs", "offboard:s1", job("offboard:s1", { signupId: "s1" }));
  return db;
}

describe("the offboarding email, as sent today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue({ sent: true, provider: "mandrill", id: "m_1" });
    tenantRegistry.tenant = TENANT;
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://app.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the default copy, from the tenant's verified sender", async () => {
    const db = world();
    expect(await processEmailJobs(ctx, 25, db)).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchInlineSnapshot(`
      {
        "fromEmail": "ada@example.com",
        "fromName": "Ada at Example",
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>Hi Maya,<br><br>Great news — you&#39;ve been moved off the Example Beta waitlist and now have access.<br><br>Thanks for being an early supporter!</div>
      </body></html>",
        "replyTo": "ada@example.com",
        "subject": "You're off the waitlist for Example Beta 🎉",
        "text": "Hi Maya,

      Great news — you've been moved off the Example Beta waitlist and now have access.

      Thanks for being an early supporter!",
        "to": "maya@example.com",
      }
    `);
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({ status: "done", mandrillMessageId: "m_1" });
  });

  it("an admin's subject and body, merged, with the subject kept on one line", async () => {
    const db = world({
      offboardingEmail: {
        subject: "Welcome in, {{first_name}}\r\nBcc: someone@example.com",
        body: "Hi {{first_name}},\n\nYou're in <b>{{waitlist_name}}</b> 🎉",
      },
    });
    await processEmailJobs(ctx, 25, db);
    expect(send.mock.calls[0]![0]).toMatchInlineSnapshot(`
      {
        "fromEmail": "ada@example.com",
        "fromName": "Ada at Example",
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>Hi Maya,<br><br>You&#39;re in &lt;b&gt;Example Beta&lt;/b&gt; 🎉</div>
      </body></html>",
        "replyTo": "ada@example.com",
        "subject": "Welcome in, Maya Bcc: someone@example.com",
        "text": "Hi Maya,

      You're in <b>Example Beta</b> 🎉",
        "to": "maya@example.com",
      }
    `);
  });

  it("in the language they signed up in", async () => {
    await processEmailJobs(ctx, 25, world({ locale: "ar" }));
    expect(send.mock.calls[0]![0]).toMatchInlineSnapshot(`
      {
        "fromEmail": "ada@example.com",
        "fromName": "Ada at Example",
        "html": "<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>مرحباً Maya،<br><br>أخبار رائعة — لقد تم قبولك من قائمة انتظار Example Beta ولديك الآن صلاحية الوصول.<br><br>شكراً لكونك من الداعمين الأوائل!</div>
      </body></html>",
        "replyTo": "ada@example.com",
        "subject": "لقد تم قبولك من قائمة الانتظار لـ Example Beta 🎉",
        "text": "مرحباً Maya،

      أخبار رائعة — لقد تم قبولك من قائمة انتظار Example Beta ولديك الآن صلاحية الوصول.

      شكراً لكونك من الداعمين الأوائل!",
        "to": "maya@example.com",
      }
    `);
  });

  it("with no tenant, from the default sender", async () => {
    tenantRegistry.tenant = null;
    await processEmailJobs(ctx, 25, world());
    expect(send.mock.calls[0]![0]).toMatchObject({ fromEmail: undefined, fromName: undefined, replyTo: undefined });
  });

  it("still goes to a suppressed address today, exactly as to anyone else", async () => {
    await processEmailJobs(ctx, 25, world());
    const db = world();
    await suppressEmail(ctx, { email: "maya@example.com", reason: "unsubscribe", source: "footer" }, db);
    expect(await processEmailJobs(ctx, 25, db)).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({ status: "done", emailSentAt: expect.any(String) });
  });
});
