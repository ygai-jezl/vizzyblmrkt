import { describe, it, expect } from "vitest";
import {
  offboardingEmail,
  verificationEmail,
  DEFAULT_OFFBOARDING_SUBJECT,
  DEFAULT_OFFBOARDING_BODY,
} from "./templates";
import { renderMergeVars } from "./mergeVars";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";

describe("offboardingEmail template", () => {
  it("uses the given subject and body verbatim in text, wrapped in HTML", () => {
    const msg = offboardingEmail({
      to: "a@b.com",
      subject: "You're in!",
      body: "Hi Jo,\nWelcome.",
    });
    expect(msg.to).toBe("a@b.com");
    expect(msg.subject).toBe("You're in!");
    expect(msg.text).toBe("Hi Jo,\nWelcome.");
    expect(msg.html).toContain("Hi Jo,<br>Welcome."); // newline → <br>
  });

  it("HTML-escapes the body so merged values can't inject markup", () => {
    const msg = offboardingEmail({
      to: "a@b.com",
      subject: "s",
      body: "Hi <script>alert(1)</script>",
    });
    expect(msg.html).toContain("&lt;script&gt;");
    expect(msg.html).not.toContain("<script>alert(1)</script>");
  });

  it("declares a utf-8 charset and preserves emoji in subject + body", () => {
    const msg = offboardingEmail({
      to: "a@b.com",
      subject: "You're off the waitlist 🎉",
      body: "Hi Jo,\nThanks for waiting 💡",
    });
    expect(msg.subject).toContain("🎉");
    expect(msg.html).toContain('meta charset="utf-8"');
    expect(msg.html).toContain("💡");
  });
});

describe("verificationEmail template", () => {
  const base = {
    to: "a@b.com",
    waitlistName: "Vizzybl Beta",
    verifyUrl: "https://x.test/verify?token=abc",
    firstName: "Maya",
  };

  it("renders the exact English copy (default locale) with the brand name + link", () => {
    const msg = verificationEmail(base);
    expect(msg.subject).toBe("Confirm your spot on the Vizzybl Beta waitlist");
    expect(msg.text).toContain("Hi Maya,");
    expect(msg.text).toContain(
      "Confirm your email to lock in your place on the Vizzybl Beta waitlist:",
    );
    expect(msg.text).toContain("https://x.test/verify?token=abc");
    expect(msg.html).toContain("<p>Hi Maya,</p>");
    expect(msg.html).toContain("<strong>Vizzybl Beta</strong>");
    expect(msg.html).toContain(">Confirm my spot</a>");
    expect(msg.html).toContain('<html lang="en" dir="ltr">');
  });

  it("falls back to a plain greeting when no first name", () => {
    const msg = verificationEmail({ ...base, firstName: null });
    expect(msg.html).toContain("<p>Hi,</p>");
    expect(msg.text?.startsWith("Hi,")).toBe(true);
  });

  it("declares a utf-8 charset in the HTML head", () => {
    const msg = verificationEmail(base);
    expect(msg.html).toContain('meta charset="utf-8"');
  });
});

describe("offboarding default copy + merge tokens", () => {
  const signup = { firstName: "Maya", lastName: "K", email: "maya@x.com" } as Signup;
  const campaign = { waitlistName: "Vizzybl Beta" } as Campaign;

  it("resolves {{first_name}} and {{waitlist_name}} in the default subject/body", () => {
    const subject = renderMergeVars(DEFAULT_OFFBOARDING_SUBJECT, { signup, campaign });
    const body = renderMergeVars(DEFAULT_OFFBOARDING_BODY, { signup, campaign });
    expect(subject).toContain("Vizzybl Beta");
    expect(body).toContain("Hi Maya,");
    expect(body).toContain("Vizzybl Beta");
    expect(body).not.toContain("{{"); // every token resolved
  });
});

// Pinned byte-for-byte: a styled confirmation and offboarding email are coming behind a flag, and
// with it off (or no style) both must stay exactly this — subject, text and HTML.
describe("today's confirmation email", () => {
  const base = {
    to: "maya@example.com",
    waitlistName: "Example Beta",
    verifyUrl: "https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123",
    firstName: "Maya",
  };

  it("named, in English", () => {
    expect(verificationEmail(base)).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>Hi Maya,</p>
        <p>Confirm your email to lock in your place on the <strong>Example Beta</strong> waitlist.</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Confirm my spot</a>
        </p>
        <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123</p>
        <p style="color:#999;font-size:12px;margin-top:28px">If you didn't sign up, you can ignore this email.</p>
      </body></html>",
        "subject": "Confirm your spot on the Example Beta waitlist",
        "text": "Hi Maya,

      Confirm your email to lock in your place on the Example Beta waitlist:
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123

      If you didn't sign up, you can ignore this email.",
        "to": "maya@example.com",
      }
    `);
  });

  it("unnamed, with a tenant hint in the link", () => {
    expect(
      verificationEmail({ ...base, firstName: null, verifyUrl: "https://app.example.com/api/waitlist/camp_1/verify?token=abc123&t=ten_1" }),
    ).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>Hi,</p>
        <p>Confirm your email to lock in your place on the <strong>Example Beta</strong> waitlist.</p>
        <p style="margin:28px 0">
          <a href="https://app.example.com/api/waitlist/camp_1/verify?token=abc123&t=ten_1" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Confirm my spot</a>
        </p>
        <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>https://app.example.com/api/waitlist/camp_1/verify?token=abc123&t=ten_1</p>
        <p style="color:#999;font-size:12px;margin-top:28px">If you didn't sign up, you can ignore this email.</p>
      </body></html>",
        "subject": "Confirm your spot on the Example Beta waitlist",
        "text": "Hi,

      Confirm your email to lock in your place on the Example Beta waitlist:
      https://app.example.com/api/waitlist/camp_1/verify?token=abc123&t=ten_1

      If you didn't sign up, you can ignore this email.",
        "to": "maya@example.com",
      }
    `);
  });

  it("markup characters in the names", () => {
    expect(verificationEmail({ ...base, waitlistName: `Tom & Jerry's <"Beta">`, firstName: `<b>Jo</b> & "Al"'s` })).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>Hi &lt;b&gt;Jo&lt;/b&gt; &amp; &quot;Al&quot;&#39;s,</p>
        <p>Confirm your email to lock in your place on the <strong>Tom &amp; Jerry&#39;s &lt;&quot;Beta&quot;&gt;</strong> waitlist.</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Confirm my spot</a>
        </p>
        <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123</p>
        <p style="color:#999;font-size:12px;margin-top:28px">If you didn't sign up, you can ignore this email.</p>
      </body></html>",
        "subject": "Confirm your spot on the Tom & Jerry's <"Beta"> waitlist",
        "text": "Hi <b>Jo</b> & "Al"'s,

      Confirm your email to lock in your place on the Tom & Jerry's <"Beta"> waitlist:
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123

      If you didn't sign up, you can ignore this email.",
        "to": "maya@example.com",
      }
    `);
  });

  it("in Arabic and Japanese", () => {
    expect(verificationEmail({ ...base, locale: "ar" })).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>مرحباً Maya،</p>
        <p>أكّد بريدك الإلكتروني لضمان مكانك في قائمة انتظار <strong>Example Beta</strong>.</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">تأكيد مكاني</a>
        </p>
        <p style="color:#666;font-size:13px">أو الصق هذا الرابط في متصفحك:<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123</p>
        <p style="color:#999;font-size:12px;margin-top:28px">إذا لم تقم بالتسجيل، يمكنك تجاهل هذا البريد الإلكتروني.</p>
      </body></html>",
        "subject": "أكّد مكانك في قائمة انتظار Example Beta",
        "text": "مرحباً Maya،

      أكّد بريدك الإلكتروني لضمان مكانك في قائمة انتظار Example Beta:
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123

      إذا لم تقم بالتسجيل، يمكنك تجاهل هذا البريد الإلكتروني.",
        "to": "maya@example.com",
      }
    `);
    expect(verificationEmail({ ...base, locale: "ja" })).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="ja" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <p>こんにちは、Mayaさん</p>
        <p>メールアドレスを認証して、<strong>Example Beta</strong>のウェイティングリストの順位を確定してください。</p>
        <p style="margin:28px 0">
          <a href="https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">登録を確定する</a>
        </p>
        <p style="color:#666;font-size:13px">または、以下のリンクをブラウザに貼り付けてください：<br>https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123</p>
        <p style="color:#999;font-size:12px;margin-top:28px">この登録に心当たりがない場合は、このメールを無視してください。</p>
      </body></html>",
        "subject": "Example Betaのウェイティングリストへの登録を確定してください",
        "text": "こんにちは、Mayaさん

      メールアドレスを認証して、Example Betaのウェイティングリストの順位を確定してください：
      https://waitlist.example.com/api/waitlist/camp_1/verify?token=abc123

      この登録に心当たりがない場合は、このメールを無視してください。",
        "to": "maya@example.com",
      }
    `);
  });
});

describe("today's offboarding email", () => {
  it("the default copy, merged", () => {
    const signup = { firstName: "Maya", lastName: "K", email: "maya@example.com" } as Signup;
    const campaign = { waitlistName: "Example Beta" } as Campaign;
    expect(
      offboardingEmail({
        to: "maya@example.com",
        subject: renderMergeVars(DEFAULT_OFFBOARDING_SUBJECT, { signup, campaign }),
        body: renderMergeVars(DEFAULT_OFFBOARDING_BODY, { signup, campaign }),
      }),
    ).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>Hi Maya,<br><br>Great news — you&#39;ve been moved off the Example Beta waitlist and now have access.<br><br>Thanks for being an early supporter!</div>
      </body></html>",
        "subject": "You're off the waitlist for Example Beta 🎉",
        "text": "Hi Maya,

      Great news — you've been moved off the Example Beta waitlist and now have access.

      Thanks for being an early supporter!",
        "to": "maya@example.com",
      }
    `);
  });

  it("a multi-line body with emoji and markup", () => {
    expect(
      offboardingEmail({
        to: "maya@example.com",
        subject: "You're in 🎉",
        body: "Hi Maya,\nThanks for waiting 💡\n\n<script>alert(1)</script> & more",
      }),
    ).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>Hi Maya,<br>Thanks for waiting 💡<br><br>&lt;script&gt;alert(1)&lt;/script&gt; &amp; more</div>
      </body></html>",
        "subject": "You're in 🎉",
        "text": "Hi Maya,
      Thanks for waiting 💡

      <script>alert(1)</script> & more",
        "to": "maya@example.com",
      }
    `);
  });

  it("in Arabic", () => {
    expect(offboardingEmail({ to: "maya@example.com", subject: "مرحبا", body: "مرحبا مايا\nشكرا", locale: "ar" })).toMatchInlineSnapshot(`
      {
        "html": "<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
        <div>مرحبا مايا<br>شكرا</div>
      </body></html>",
        "subject": "مرحبا",
        "text": "مرحبا مايا
      شكرا",
        "to": "maya@example.com",
      }
    `);
  });
});
