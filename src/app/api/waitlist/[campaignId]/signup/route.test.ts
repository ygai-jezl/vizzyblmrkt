import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEmailStyle } from "@/lib/email/resolveEmailStyle";

/**
 * The double opt-in confirmation email as the signup route sends it today, pinned whole. A
 * styled version is coming behind a flag (EMAIL_STYLE_TRANSACTIONAL_ENABLED); with it off, the
 * payload must not change, even for a tenant with an Email style saved and the Email style flag
 * on. Everything but the route's own logic, the sender and the template is stubbed.
 */

const CAMPAIGN = {
  id: "camp_1",
  tenantId: "ten_A",
  waitlistName: "Join the Example Beta",
  productName: "Example Beta",
  requiredContactDetail: "EMAIL",
  usesFirstnameLastname: false,
  questions: [],
  archivedAt: null,
  strategy: { supportedLocales: ["en", "ar"] },
};
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
    logo: null,
    companyName: "Example Co",
    headerColor: "#0b1f3a",
    accentColor: "#ff6b35",
  },
};

const m = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createSignup: vi.fn(),
  deleteSignup: vi.fn(async () => undefined),
  resolveTenantForRequest: vi.fn(),
  tenant: null as unknown,
  styledThrows: false,
}));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    resolveTenantForRequest: m.resolveTenantForRequest,
    forTenant: () => ({ campaigns: { getById: async () => CAMPAIGN }, signups: { delete: m.deleteSignup } }),
    creditReferral: vi.fn(),
    getTenantById: vi.fn(async () => m.tenant),
  };
});
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
// Lets a test make the styled render throw; everything else is the real template.
vi.mock("@/lib/email/templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/templates")>();
  return {
    ...actual,
    verificationEmail: (opts: Parameters<typeof actual.verificationEmail>[0]) => {
      if (opts.style && m.styledThrows) throw new Error("styled render failed");
      return actual.verificationEmail(opts);
    },
  };
});
vi.mock("@/lib/waitlist/signupService", () => ({ createSignup: m.createSignup }));
vi.mock("@/lib/waitlist/postSignup", () => ({ buildSharePayload: vi.fn(async () => ({})) }));
vi.mock("@/lib/security/recaptcha", () => ({ verifyRecaptcha: vi.fn(async () => ({ ok: true, skipped: true })) }));
vi.mock("@/lib/mailchimp", () => ({ syncSignupToAudience: vi.fn() }));
vi.mock("@/lib/journey/router", () => ({ enrolSignupInWaitlistJourney: vi.fn() }));
vi.mock("@/lib/crm/contactService", () => ({ recordSignupContact: vi.fn() }));

const { POST } = await import("./route");

const signup = (over: Record<string, unknown> = {}) => ({
  id: "sig_1",
  email: "maya@example.com",
  firstName: "Maya",
  status: "unverified",
  verificationToken: "tok abc/123",
  referralToken: "ref_1",
  ...over,
});

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("https://waitlist.example.com/api/waitlist/camp_1/signup?t=ten_A", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "waitlist.example.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ campaignId: "camp_1" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.tenant = TENANT;
  m.styledThrows = false;
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
  m.resolveTenantForRequest.mockResolvedValue({ tenantId: "ten_A", region: "us", source: "tenant_param" });
  m.createSignup.mockResolvedValue({ alreadyJoined: false, signup: signup(), totalSignups: 12 });
  m.sendEmail.mockResolvedValue({ sent: true, provider: "mandrill", id: "m_1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/waitlist/[campaignId]/signup: the confirmation email, as sent today", () => {
  it("sends exactly this, from the tenant's verified sender, and answers 201", async () => {
    const res = await post({ email: "maya@example.com", firstName: "Maya" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      alreadyJoined: false,
      status: "unverified",
      needsVerification: true,
      referralToken: "ref_1",
      totalSignups: 12,
    });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toMatchInlineSnapshot(`
      {
        "fromEmail": "ada@example.com",
        "fromName": "Ada at Example",
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>Hi Maya,</p>
        <p>Confirm your email to lock in your place on the <strong>Example Beta</strong> waitlist.</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Confirm my spot</a>
        </p>
        <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A</p>
        <p style="color:#999;font-size:12px;margin-top:28px">If you didn't sign up, you can ignore this email.</p>
      </body></html>",
        "replyTo": "ada@example.com",
        "subject": "Confirm your spot on the Example Beta waitlist",
        "text": "Hi Maya,

      Confirm your email to lock in your place on the Example Beta waitlist:
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A

      If you didn't sign up, you can ignore this email.",
        "to": "maya@example.com",
      }
    `);
    expect(m.deleteSignup).not.toHaveBeenCalled();
  });

  it("in the visitor's language, with no name", async () => {
    m.createSignup.mockResolvedValue({ alreadyJoined: false, signup: signup({ firstName: null }), totalSignups: 12 });
    await post({ email: "maya@example.com", locale: "ar" });
    expect(m.sendEmail.mock.calls[0]![0]).toMatchInlineSnapshot(`
      {
        "fromEmail": "ada@example.com",
        "fromName": "Ada at Example",
        "html": "<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>مرحباً،</p>
        <p>أكّد بريدك الإلكتروني لضمان مكانك في قائمة انتظار <strong>Example Beta</strong>.</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">تأكيد مكاني</a>
        </p>
        <p style="color:#666;font-size:13px">أو الصق هذا الرابط في متصفحك:<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A</p>
        <p style="color:#999;font-size:12px;margin-top:28px">إذا لم تقم بالتسجيل، يمكنك تجاهل هذا البريد الإلكتروني.</p>
      </body></html>",
        "replyTo": "ada@example.com",
        "subject": "أكّد مكانك في قائمة انتظار Example Beta",
        "text": "مرحباً،

      أكّد بريدك الإلكتروني لضمان مكانك في قائمة انتظار Example Beta:
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&t=ten_A

      إذا لم تقم بالتسجيل، يمكنك تجاهل هذا البريد الإلكتروني.",
        "to": "maya@example.com",
      }
    `);
  });

  it("a send that fails deletes the new signup and answers 503", async () => {
    m.sendEmail.mockResolvedValue({ sent: false, provider: "mandrill", reason: "http_400" });
    const res = await post({ email: "maya@example.com", firstName: "Maya" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "verification_unavailable" });
    expect(m.deleteSignup).toHaveBeenCalledWith("sig_1");
  });

  it("a send that throws does the same", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.sendEmail.mockRejectedValue(new Error("boom"));
    const res = await post({ email: "maya@example.com", firstName: "Maya" });
    expect(res.status).toBe(503);
    expect(m.deleteSignup).toHaveBeenCalledWith("sig_1");
    warn.mockRestore();
  });

  it("sends nothing to someone already on the list, or already verified", async () => {
    m.createSignup.mockResolvedValue({ alreadyJoined: true, signup: signup(), totalSignups: 12 });
    expect((await post({ email: "maya@example.com" })).status).toBe(200);
    m.createSignup.mockResolvedValue({ alreadyJoined: false, signup: signup({ status: "verified_active", verificationToken: null }), totalSignups: 12 });
    expect((await post({ email: "maya@example.com" })).status).toBe(201);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/waitlist/[campaignId]/signup: with EMAIL_STYLE_TRANSACTIONAL_ENABLED", () => {
  const HEADER_IMAGE = { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg", width: 1200, height: 300 };
  const URL_HTML = "https://waitlist.example.com/api/waitlist/camp_1/verify?token=tok%20abc%2F123&amp;t=ten_A";
  let plain: Record<string, unknown>;

  beforeEach(async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_LINK_ORIGIN", "https://app.example.com");
    // Today's payload, from the pins above, to compare against.
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "false");
    await post({ email: "maya@example.com", firstName: "Maya" });
    plain = m.sendEmail.mock.calls[0]![0];
    m.sendEmail.mockClear();
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "true");
  });

  it("wears the colour header, never the saved banner, with the link escaped; subject, text and sender unchanged", async () => {
    m.tenant = { ...TENANT, emailStyle: { ...TENANT.emailStyle, headerImage: HEADER_IMAGE } };
    expect(resolveEmailStyle(m.tenant as never)).toHaveProperty("headerImage"); // the brand's other emails show it
    const res = await post({ email: "maya@example.com", firstName: "Maya" });
    expect(res.status).toBe(201);
    const { html, ...rest } = m.sendEmail.mock.calls[0]![0];
    const { html: plainHtml, ...plainRest } = plain;
    expect(rest).toEqual(plainRest);
    expect(html).not.toBe(plainHtml);
    expect(html).toContain('<td bgcolor="#0b1f3a" align="left" style="padding:16px 24px;background-color:#0b1f3a"><span');
    expect(html).toContain(">Example Co</span>");
    expect(html).not.toContain("/api/brand-asset/header/");
    expect(html).toContain(`<td bgcolor="#ff6b35" style="background:#ff6b35;border-radius:8px"><a href="${URL_HTML}"`);
    expect(html).toContain(`<br>${URL_HTML}</p>`);
    expect(html).not.toContain("&t=ten_A");
    expect(html).not.toContain("data-vzb-footer");
    expect(m.deleteSignup).not.toHaveBeenCalled();
  });

  it("with no Email style saved: today's email, exactly", async () => {
    m.tenant = { ...TENANT, emailStyle: undefined };
    await post({ email: "maya@example.com", firstName: "Maya" });
    expect(m.sendEmail.mock.calls[0]![0]).toEqual(plain);
  });

  it("a styled render that throws sends today's email instead, and the signup stands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.styledThrows = true;
    const res = await post({ email: "maya@example.com", firstName: "Maya" });
    expect(res.status).toBe(201);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toEqual(plain);
    expect(m.deleteSignup).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("styled verification email failed"), expect.any(Error));
    warn.mockRestore();
  });
});
