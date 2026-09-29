import { describe, it, expect } from "vitest";
import { compileJourneyEmail, compileBroadcast } from "./compiler";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { htmlToText } from "@/lib/email/emailRender";
import { EMAIL_FONTS, FONT } from "@/lib/email/emailFonts";

const campaign = { waitlistName: "Beta" } as unknown as Campaign;

describe("compileJourneyEmail (per-recipient, escaped)", () => {
  it("escapes subscriber-controlled values but keeps the author's HTML", () => {
    const signup = {
      firstName: "<img src=x onerror=alert(1)>",
      referralLink: "https://x.test/r",
      amountReferred: 0,
    } as unknown as Signup;
    const out = compileJourneyEmail(
      { subject: "hi", body: "<p>Hi {{first_name}}</p>" },
      { signup, campaign, rank: 1 },
    );
    // Injected markup is neutralised…
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out.html).not.toContain("<img src=x onerror");
    // …but the author's own <p> tag survives.
    expect(out.html).toContain("<p>Hi ");
  });

  it("escapes once for a plain-text body (no double-escaping)", () => {
    const signup = { firstName: "A&B", amountReferred: 0 } as unknown as Signup;
    const out = compileJourneyEmail(
      { subject: "s", body: "Hi {{first_name}}" },
      { signup, campaign },
    );
    expect(out.html).toContain("Hi A&amp;B");
    expect(out.html).not.toContain("A&amp;amp;B");
  });
});

describe("compileBroadcast (audience-wide, MailChimp tags)", () => {
  it("maps merge vars to MailChimp tags", () => {
    const out = compileBroadcast(
      { subject: "Hi {{first_name}}", body: "<p>Yo {{first_name}}</p>" },
      campaign,
    );
    expect(out.subject).toContain("*|FNAME|*");
    expect(out.html).toContain("*|FNAME|*");
  });

  it("raises the QA gate for ENTERPRISE_TRUST shouting subjects", () => {
    const ent = {
      waitlistName: "Beta",
      strategy: { brandTone: "ENTERPRISE_TRUST" },
    } as unknown as Campaign;
    const out = compileBroadcast({ subject: "URGENT!!", body: "x" }, ent);
    expect(out.warnings).toContain("subject_shouting");
  });

  it("detects shouting in non-Latin cased scripts (Cyrillic), not just ASCII", () => {
    const ent = {
      waitlistName: "Бета",
      strategy: { brandTone: "ENTERPRISE_TRUST" },
    } as unknown as Campaign;
    // "СРОЧНО" = 6 Cyrillic uppercase letters — would slip past the old /[A-Z]/.
    const out = compileBroadcast({ subject: "СРОЧНО предложение", body: "x" }, ent);
    expect(out.warnings).toContain("subject_shouting");
  });

  it("does NOT false-flag caseless scripts (Japanese) as shouting", () => {
    const ent = {
      waitlistName: "ベータ",
      strategy: { brandTone: "ENTERPRISE_TRUST" },
    } as unknown as Campaign;
    const out = compileBroadcast({ subject: "緊急セール今すぐご登録", body: "x" }, ent);
    expect(out.warnings).not.toContain("subject_shouting");
  });

  it("counts full-width (CJK) exclamation marks toward the excess-exclamation gate", () => {
    const ent = {
      waitlistName: "ベータ",
      strategy: { brandTone: "ENTERPRISE_TRUST" },
    } as unknown as Campaign;
    const out = compileBroadcast({ subject: "登録してね！！", body: "x" }, ent);
    expect(out.warnings).toContain("subject_excess_exclamation");
  });
});

describe("mandatory footer (safety net + token resolution)", () => {
  const footer = {
    brand: "Acme Team",
    unsubscribeUrl: "https://app.test/unsubscribe?u=tok",
    managePreferencesUrl: "https://app.test/unsubscribe?u=tok",
    privacyUrl: "https://acme.test/privacy",
  };

  it("journey: appends a footer to a raw body and resolves its tokens", () => {
    const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
    const out = compileJourneyEmail(
      { subject: "s", body: "<p>Hello</p>" },
      { signup, campaign, footer },
    );
    expect(out.html).toContain("data-vzb-footer");
    expect(out.html).toContain("This email was sent by Acme Team.");
    expect(out.html).toContain('href="https://app.test/unsubscribe?u=tok"');
    expect(out.html).toContain('href="https://acme.test/privacy"');
    expect(out.html).not.toContain("{{sender_brand}}");
    expect(out.html).not.toContain("{{unsubscribe_url}}");
  });

  it("journey: keeps the unsubscribe URL + no literal entities in the text/plain part", () => {
    const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
    const out = compileJourneyEmail({ subject: "s", body: "<p>Hi</p>" }, { signup, campaign, footer });
    // The footer's Unsubscribe link survives into text/plain with its URL…
    expect(out.text).toContain("Unsubscribe (https://app.test/unsubscribe?u=tok)");
    // …and the &nbsp; separators are decoded, not shown as literal entity codes.
    expect(out.text).not.toContain("&nbsp;");
  });

  it("journey: does NOT double-append when the body already carries a footer", () => {
    const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
    const body = `<p>Hi</p><div data-vzb-footer="1">This email was sent by {{sender_brand}}.</div>`;
    const out = compileJourneyEmail({ subject: "s", body }, { signup, campaign, footer });
    expect(out.html.match(/data-vzb-footer/g)?.length).toBe(1);
    expect(out.html).toContain("This email was sent by Acme Team.");
  });

  it("journey: does NOT double-append for a LEGACY footer (only the {{unsubscribe_url}} token)", () => {
    const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
    // Old footer blocks predate the data-vzb-footer marker.
    const body = `<p>Hi</p><div>Old footer <a href="{{unsubscribe_url}}">Unsubscribe</a></div>`;
    const out = compileJourneyEmail({ subject: "s", body }, { signup, campaign, footer });
    // The legacy token resolved, and no second (marker) footer was appended.
    expect(out.html).not.toContain("data-vzb-footer");
    expect(out.html).toContain('href="https://app.test/unsubscribe?u=tok"');
  });

  it("journey: appends a footer to a plain-text body too", () => {
    const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
    const out = compileJourneyEmail(
      { subject: "s", body: "Just some plain text" },
      { signup, campaign, footer },
    );
    expect(out.html).toContain("data-vzb-footer");
    expect(out.html).toContain("This email was sent by Acme Team.");
  });

  it("broadcast: footer uses MailChimp native tags + resolved brand/privacy", () => {
    const out = compileBroadcast(
      { subject: "s", body: "<p>Yo</p>" },
      campaign,
      footer,
    );
    expect(out.html).toContain("data-vzb-footer");
    expect(out.html).toContain("This email was sent by Acme Team.");
    expect(out.html).toContain('href="*|UNSUB|*"');
    expect(out.html).toContain('href="*|UPDATE_PROFILE|*"');
    expect(out.html).toContain('href="https://acme.test/privacy"');
  });
});

// Pinned byte-for-byte: with no Email style saved, sends must stay exactly this.
describe("today's output", () => {
  const launch = { waitlistName: "Example Beta", productName: "Example" } as unknown as Campaign;
  const footer = {
    brand: "Example Co",
    unsubscribeUrl: "https://waitlist.example.com/unsubscribe?u=tok",
    managePreferencesUrl: "https://waitlist.example.com/preferences?u=tok",
    privacyUrl: "https://example.com/privacy",
  };

  it("broadcast html", () => {
    const out = compileBroadcast(
      {
        subject: "This week at {{waitlist_name}}",
        body: '<h2>This week</h2>\n<p>Hi {{first_name}}, here\'s what\'s new.</p>\n<p><a href="https://example.com/blog/update">Read the update</a></p>',
        heroImageUrl: "https://cdn.example.com/weekly.png",
      },
      launch,
      footer,
    );
    expect(out.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://cdn.example.com/weekly.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          <h2>This week</h2>
      <p>Hi *|FNAME|*, here's what's new.</p>
      <p><a href="https://example.com/blog/update">Read the update</a></p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br /><a href="*|UPDATE_PROFILE|*" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="*|UNSUB|*" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
  });

  it("journey html and text", () => {
    const signup = {
      firstName: "Jo",
      referralLink: "https://waitlist.example.com/beta?ref=abc123",
      amountReferred: 2,
    } as unknown as Signup;
    const out = compileJourneyEmail(
      {
        subject: "You're on the {{waitlist_name}} list",
        body: "Hi {{first_name}},\n\nYou're #{{current_rank}} on the {{waitlist_name}} list.\n\nShare your link to move up: {{referral_link}}",
        heroImageUrl: "https://cdn.example.com/welcome.png",
      },
      { signup, campaign: launch, rank: 42, footer },
    );
    expect(out.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://cdn.example.com/welcome.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          <p>Hi Jo,</p>
      <p>You&#39;re #42 on the Example list.</p>
      <p>Share your link to move up: https://waitlist.example.com/beta?ref=abc123</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br /><a href="https://waitlist.example.com/preferences?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://waitlist.example.com/unsubscribe?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
    expect(out.text).toMatchInlineSnapshot(`
      "Hi Jo,

      You're #42 on the Example list.

      Share your link to move up: https://waitlist.example.com/beta?ref=abc123
      This email was sent by Example Co.
      Manage preferences (https://waitlist.example.com/preferences?u=tok) | Unsubscribe (https://waitlist.example.com/unsubscribe?u=tok) | Privacy Policy (https://example.com/privacy)"
    `);
  });
});

describe("with an Email style", () => {
  const launch = { waitlistName: "Example Beta", productName: "Example" } as unknown as Campaign;
  const footer = {
    brand: "Example Co",
    unsubscribeUrl: "https://waitlist.example.com/unsubscribe?u=tok",
    managePreferencesUrl: "https://waitlist.example.com/preferences?u=tok",
    privacyUrl: "https://example.com/privacy",
  };
  const style = (over: Partial<ResolvedEmailStyle> = {}): ResolvedEmailStyle => ({
    logo: { url: "https://app.example.com/api/brand-logo/ten_1/11111111-2222-4333-8444-555555555555.png", width: 120, height: 40 },
    name: "Example Co",
    altName: "Example Co",
    headerColor: "#0b1f3a",
    accentColor: "#1d4ed8",
    ...over,
  });
  const signup = { firstName: "Jo", amountReferred: 0 } as unknown as Signup;
  const bodies = ["<p>Hi {{first_name}}</p>", "Hi {{first_name}}", `<p>Hi</p><div data-vzb-footer="1">Sent by {{sender_brand}}.</div>`];

  it("no style (null or absent) is today's output", () => {
    const content = { subject: "s", body: "<p>Hi {{first_name}}</p>", heroImageUrl: "https://cdn.example.com/a.png" };
    expect(compileBroadcast(content, launch, footer, null)).toEqual(compileBroadcast(content, launch, footer));
    expect(compileJourneyEmail(content, { signup, campaign: launch, footer }, null)).toEqual(
      compileJourneyEmail(content, { signup, campaign: launch, footer }),
    );
  });

  it("adds the band, with exactly one footer", () => {
    for (const body of bodies) {
      const b = compileBroadcast({ subject: "s", body }, launch, footer, style());
      const j = compileJourneyEmail({ subject: "s", body }, { signup, campaign: launch, footer }, style());
      for (const html of [b.html, j.html]) {
        expect(html).toContain('bgcolor="#0b1f3a"');
        expect(html.match(/data-vzb-footer/g)).toHaveLength(1);
      }
    }
  });

  it("keeps the journey's text/plain part exactly as it was", () => {
    for (const body of bodies) {
      const content = { subject: "s", body, heroImageUrl: "https://cdn.example.com/a.png" };
      const plain = compileJourneyEmail(content, { signup, campaign: launch, footer });
      const styled = compileJourneyEmail(content, { signup, campaign: launch, footer }, style({ logo: null, name: "Band Name", altName: "Band Name" }));
      expect(styled.html).toContain(">Band Name</span>");
      expect(styled.text).toBe(plain.text);
    }
  });

  it("leads with the body, not the band's name, as the inbox snippet", () => {
    const named = style({ logo: null, name: "Band Name", altName: "Band Name" });
    const b = compileBroadcast({ subject: "s", body: "<p>Hi {{first_name}}, here's the news.</p>" }, launch, footer, named);
    const j = compileJourneyEmail({ subject: "s", body: "Hi {{first_name}}, here's the news." }, { signup, campaign: launch, footer }, named);
    expect(htmlToText(b.html)).toMatch(/^Hi \*\|FNAME\|\*, here's the news\. This email was sent by Example Co\./);
    expect(htmlToText(j.html)).toMatch(/^Hi Jo, here's the news\. This email was sent by Example Co\./);
    // A preheader of its own is used instead.
    const own = compileJourneyEmail({ subject: "s", body: "<p>Hi</p>" }, { signup, campaign: launch, footer }, named, "Soon");
    expect(htmlToText(own.html)).toMatch(/^Soon\nBand Name/);
  });

  // Pinned byte-for-byte: a themed footer is coming behind a flag, and with it off (or no theme
  // saved) styled broadcasts and journey emails, with the appended footer, must stay exactly this.
  it("pins today's styled journey email: an HTML body, then a plain one, each with the appended footer", () => {
    const merge = { signup: { firstName: "Jo", amountReferred: 0 } as unknown as Signup, campaign: launch, rank: 7, footer };
    const html = compileJourneyEmail({ subject: "You're #{{current_rank}}", body: "<p>Hi {{first_name}}, you're #{{current_rank}}.</p>" }, merge, style());
    expect(html.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">Hi Jo, you're #7. This email was sent by Example Co. Manage preferences &nbsp;|&nbsp; Unsubscribe &nbsp;|&nbsp; Privacy Policy</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#0b1f3a" style="width:100%;max-width:608px;margin:0 auto;background-color:#0b1f3a"><tr><td bgcolor="#0b1f3a" align="left" style="padding:16px 24px;background-color:#0b1f3a"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/ten_1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Example Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p>Hi Jo, you're #7.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br /><a href="https://waitlist.example.com/preferences?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://waitlist.example.com/unsubscribe?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
    expect(html.text).toMatchInlineSnapshot(`
      "Hi Jo, you're #7.
      This email was sent by Example Co.
      Manage preferences (https://waitlist.example.com/preferences?u=tok) | Unsubscribe (https://waitlist.example.com/unsubscribe?u=tok) | Privacy Policy (https://example.com/privacy)"
    `);
    const plain = compileJourneyEmail(
      { subject: "s", body: "Hi {{first_name}},\n\nYou're #{{current_rank}}.", heroImageUrl: "https://cdn.example.com/welcome.png" },
      merge,
      style(),
      "You moved up",
    );
    expect(plain.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">You moved up</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#0b1f3a" style="width:100%;max-width:608px;margin:0 auto;background-color:#0b1f3a"><tr><td bgcolor="#0b1f3a" align="left" style="padding:16px 24px;background-color:#0b1f3a"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/ten_1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Example Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://cdn.example.com/welcome.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          <p>Hi Jo,</p>
      <p>You&#39;re #7.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br /><a href="https://waitlist.example.com/preferences?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://waitlist.example.com/unsubscribe?u=tok" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
    expect(plain.text).toMatchInlineSnapshot(`
      "Hi Jo,

      You're #7.
      This email was sent by Example Co.
      Manage preferences (https://waitlist.example.com/preferences?u=tok) | Unsubscribe (https://waitlist.example.com/unsubscribe?u=tok) | Privacy Policy (https://example.com/privacy)"
    `);
  });

  it("pins today's styled broadcast, with the appended footer", () => {
    const out = compileBroadcast(
      { subject: "This week", body: "<h2>This week</h2>\n<p>Hi {{first_name}}, here's what's new.</p>", heroImageUrl: "https://cdn.example.com/weekly.png" },
      launch,
      footer,
      style(),
    );
    expect(out.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;background:#f6f6f6">
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">This week Hi *|FNAME|*, here's what's new. This email was sent by Example Co. Manage preferences &nbsp;|&nbsp; Unsubscribe &nbsp;|&nbsp; Privacy Polic</div><!--[if mso]><table role="presentation" width="608" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" bgcolor="#0b1f3a" style="width:100%;max-width:608px;margin:0 auto;background-color:#0b1f3a"><tr><td bgcolor="#0b1f3a" align="left" style="padding:16px 24px;background-color:#0b1f3a"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="https://app.example.com/api/brand-logo/ten_1/11111111-2222-4333-8444-555555555555.png" width="120" height="40" alt="" style="display:block;width:120px;height:40px;border:0;outline:none;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff" /></td><td style="vertical-align:middle;padding-left:12px"><span style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#ffffff">Example Co</span></td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]-->
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          <img src="https://cdn.example.com/weekly.png" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>
          <h2>This week</h2>
      <p>Hi *|FNAME|*, here's what's new.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Example Co.<br /><a href="*|UPDATE_PROFILE|*" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="*|UNSUB|*" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
  });

  it("with a theme, the appended footer takes its body font, and the text part doesn't change", () => {
    const themed = style({ theme: { preset: "editorial", headingFont: "lora", bodyFont: "verdana" } });
    const footerFont = `border-top:1px solid #ededed;font-family:${EMAIL_FONTS.verdana.safeStack};font-size:12px`;
    const merge = { signup, campaign: launch, rank: 7, footer };
    for (const body of ["<p>Hi {{first_name}}</p>", "Hi {{first_name}},\n\nWelcome."]) {
      const j = compileJourneyEmail({ subject: "s", body, heroImageUrl: "https://cdn.example.com/a.png" }, merge, themed);
      expect(j.html).toContain(footerFont);
      expect(j.html).not.toContain(FONT);
      expect(j.html.match(/data-vzb-footer/g)).toHaveLength(1);
      expect(j.text).toBe(compileJourneyEmail({ subject: "s", body, heroImageUrl: "https://cdn.example.com/a.png" }, merge, style()).text);
      expect(j.text).toBe(compileJourneyEmail({ subject: "s", body, heroImageUrl: "https://cdn.example.com/a.png" }, merge).text);
    }
    const b = compileBroadcast({ subject: "s", body: "<p>Hi {{first_name}}</p>" }, launch, footer, themed);
    expect(b.html).toContain(footerFont);
    expect(b.html).not.toContain(FONT);
    expect(b.html).toContain('href="*|UNSUB|*"');
    // The page colour and the card come from wrap(); a style with no theme is the pinned email above.
    expect(b.html).toContain('bgcolor="#f7f3ec"');
    expect(compileBroadcast({ subject: "s", body: "<p>Hi</p>" }, launch, footer, style()).html).toContain(
      `border-top:1px solid #ededed;font-family:${FONT};font-size:12px`,
    );
  });

  it("with web fonts, the HTML carries their block and the text part never does", () => {
    const web = style({ theme: { preset: "friendly", headingFont: "poppins", bodyFont: "nunito", webFontOrigin: "https://app.example.com" } });
    const merge = { signup, campaign: launch, rank: 7, footer };
    for (const body of bodies) {
      const content = { subject: "s", body, heroImageUrl: "https://cdn.example.com/a.png" };
      const j = compileJourneyEmail(content, merge, web);
      expect(j.html).toContain("<!--[if !mso]><!--><style data-vzb-fonts>");
      expect(j.html).toContain('class="vzb-card"');
      expect(j.text).not.toContain("@font-face");
      expect(j.text).not.toContain("vzb-");
      expect(j.text).toBe(compileJourneyEmail(content, merge).text);
      // The inbox snippet is the body's opening words, never the CSS.
      expect(j.html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/)?.[1]).not.toMatch(/font|vzb/);
    }
    // Broadcasts carry it too (Mailchimp inlines no CSS unless a campaign asks it to).
    const b = compileBroadcast({ subject: "s", body: "<p>Hi {{first_name}}</p>" }, launch, footer, web);
    expect(b.html).toContain("<style data-vzb-fonts>");
    expect(b.html).toContain("url(https://app.example.com/email-fonts/poppins-700.v1.woff2)");
  });

  it("escapes a | in the name, so MailChimp can't expand a tag in the band", () => {
    const out = compileBroadcast({ subject: "s", body: "<p>Yo</p>" }, launch, footer, style({ name: "Acme *|UNSUB|*", altName: "Acme *|UNSUB|*" }));
    expect(out.html).toContain(">Acme *&#124;UNSUB&#124;*</span>");
    const logoOnly = compileBroadcast({ subject: "s", body: "<p>Yo</p>" }, launch, footer, style({ name: null, altName: "Acme *|UNSUB|*" }));
    expect(logoOnly.html).toContain('alt="Acme *&#124;UNSUB&#124;*"');
    // The only live tag left is the footer's own unsubscribe link.
    expect(out.html.match(/\*\|UNSUB\|\*/g)).toEqual(["*|UNSUB|*"]);
    expect(out.html).toContain('href="*|UNSUB|*"');
  });
});

describe("emoji + charset robustness", () => {
  it("preserves emoji in a journey email's subject + body and declares utf-8", () => {
    const signup = { firstName: "Maya", amountReferred: 0 } as unknown as Signup;
    const out = compileJourneyEmail(
      { subject: "You're in 🎉", body: "<p>Welcome 💡 {{first_name}}</p>" },
      { signup, campaign },
    );
    expect(out.subject).toBe("You're in 🎉"); // subject is plain text, emoji untouched
    expect(out.html).toContain("Welcome 💡");
    expect(out.text).toContain("Welcome 💡"); // emoji survive the html→text step
    expect(out.html).toContain('meta charset="utf-8"');
  });

  it("preserves emoji in a broadcast and declares utf-8", () => {
    const out = compileBroadcast(
      { subject: "Big news 🎉", body: "<p>Check this out 💡</p>" },
      campaign,
    );
    expect(out.subject).toContain("🎉");
    expect(out.html).toContain("💡");
    expect(out.html).toContain('meta charset="utf-8"');
  });
});
