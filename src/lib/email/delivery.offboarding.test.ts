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
// Lets a test make the styled render throw; everything else is the real template.
const render = vi.hoisted(() => ({ styledThrows: false }));
vi.mock("./templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./templates")>();
  return {
    ...actual,
    offboardingEmail: (opts: Parameters<typeof actual.offboardingEmail>[0]) => {
      if (opts.style && render.styledThrows) throw new Error("styled render failed");
      return actual.offboardingEmail(opts);
    },
  };
});

import { processEmailJobs } from "./delivery";
import { sendEmail } from "@/lib/email";
import { suppressEmail } from "./suppression";
import { resolveEmailStyle } from "./resolveEmailStyle";
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

describe("the offboarding email, with EMAIL_STYLE_TRANSACTIONAL_ENABLED", () => {
  const LOGO = "https://app.example.com/api/brand-logo/ten_A/0f8fad5b-d9cb-469f-a165-70867728950e.png";
  let plain: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    render.styledThrows = false;
    send.mockResolvedValue({ sent: true, provider: "mandrill", id: "m_1" });
    tenantRegistry.tenant = TENANT;
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://app.example.com");
    // Today's payload, from the pins above, to compare against.
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "false");
    await processEmailJobs(ctx, 25, world());
    plain = send.mock.calls[0]![0];
    send.mockClear();
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("wears the colour header and the card, never the saved banner; subject, text and sender unchanged", async () => {
    expect(resolveEmailStyle(TENANT as never)).toHaveProperty("headerImage"); // the brand's other emails show it
    const db = world();
    expect(await processEmailJobs(ctx, 25, db)).toMatchObject({ processed: 1, done: 1, failed: 0 });
    const sent = send.mock.calls[0]![0];
    const { html, ...rest } = sent;
    const { html: plainHtml, ...plainRest } = plain;
    expect(rest).toEqual(plainRest);
    expect(html).not.toBe(plainHtml);
    expect(html).toContain('<td bgcolor="#0b1f3a" align="left" style="padding:16px 24px;background-color:#0b1f3a">');
    expect(html).toContain(`<img src="${LOGO}"`);
    expect(html).not.toContain("/api/brand-asset/header/");
    expect(html).toContain("<div>Hi Maya,<br><br>Great news — you&#39;ve been moved off the Example Beta waitlist");
    expect(html).not.toContain("data-vzb-footer");
    expect(html).not.toContain("{{");
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({ status: "done", mandrillMessageId: "m_1" });
  });

  it("in Arabic: right to left, with the header on the right", async () => {
    await processEmailJobs(ctx, 25, world({ locale: "ar" }));
    const { html } = send.mock.calls[0]![0];
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<td bgcolor="#0b1f3a" dir="rtl" align="right"');
  });

  it("sends nothing to a suppressed address, and the job is done", async () => {
    const db = world();
    await suppressEmail(ctx, { email: "maya@example.com", reason: "unsubscribe", source: "footer" }, db);
    expect(await processEmailJobs(ctx, 25, db)).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({ status: "done", emailSentAt: null });
  });

  it("with no Email style saved, a damaged one or the Email style off: today's email, exactly", async () => {
    tenantRegistry.tenant = { ...TENANT, emailStyle: undefined };
    await processEmailJobs(ctx, 25, world());
    tenantRegistry.tenant = { ...TENANT, emailStyle: { ...TENANT.emailStyle, headerColor: "red" } };
    await processEmailJobs(ctx, 25, world());
    tenantRegistry.tenant = TENANT;
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    await processEmailJobs(ctx, 25, world());
    expect(send).toHaveBeenCalledTimes(3);
    for (const [payload] of send.mock.calls) expect(payload).toEqual(plain);
  });

  it("a styled render that throws sends today's email instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render.styledThrows = true;
    const db = world();
    expect(await processEmailJobs(ctx, 25, db)).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual(plain);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("styled offboarding email failed"), expect.any(Error));
    warn.mockRestore();
  });
});
