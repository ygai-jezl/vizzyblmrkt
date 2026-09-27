import { describe, expect, it } from "vitest";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import { defaultInviteCopy, ensureInviteLink, hasInviteLink, renderInviteEmail } from "./render";

const merge = {
  signup: { id: "sig_1", firstName: "Amara <b>", email: "amara@example.test", referralLink: "https://x/r" } as Signup,
  campaign: { id: "beta", name: "Fernlight Beta", productName: "Fernlight" } as unknown as Campaign,
  footer: { brand: "Fernlight", unsubscribeUrl: "https://waitlist.example.com/unsubscribe?u=t", managePreferencesUrl: "", privacyUrl: "" },
};
const URL_ = "https://waitlist.example.com/invite/abc.def";

describe("invite email", () => {
  it("renders the default copy with a button, product name, days and escaped merge values", () => {
    const { subject, body } = defaultInviteCopy("en");
    const out = renderInviteEmail({ subject, body, merge, inviteUrl: URL_, productName: "Fernlight", expiresInDays: 30 });
    expect(out.subject).toBe("You're in: Fernlight is ready for you");
    expect(out.html).toContain(`href="${URL_}"`);
    expect(out.html).toContain(">Join Fernlight</a>");
    expect(out.html).toContain("works for 30 days");
    expect(out.html).toContain("Amara &lt;b&gt;");
    expect(out.html).not.toMatch(/YGINV1/);
    expect(out.text).toContain(URL_);
    expect(out.text).not.toMatch(/YGINV1/);
    // The mandatory footer (unsubscribe) is still there.
    expect(out.html).toContain("https://waitlist.example.com/unsubscribe?u=t");
  });

  it("adds the link when the author left it out, in plain text and HTML bodies", () => {
    expect(hasInviteLink("Hi {{ invite_link }}")).toBe(true);
    expect(ensureInviteLink("Hi there")).toBe("Hi there\n\n{{invite_link}}");
    expect(ensureInviteLink("<p>Hi</p>")).toBe("<p>Hi</p>\n<p>{{invite_link}}</p>");
    const out = renderInviteEmail({ subject: "Hi", body: "No link here", merge, inviteUrl: URL_, productName: "F", expiresInDays: 7 });
    expect(out.html).toContain(`href="${URL_}"`);
  });

  it("escapes a product name in HTML and keeps the subject on one line", () => {
    const out = renderInviteEmail({
      subject: "{{product_name}}\r\nBcc: x@evil.test",
      body: "{{product_name}} {{invite_link}}",
      merge,
      inviteUrl: URL_,
      productName: "A&B <app>",
      expiresInDays: 30,
    });
    expect(out.subject).toBe("A&B <app> Bcc: x@evil.test");
    expect(out.html).toContain("A&amp;B &lt;app&gt;");
    expect(out.html).toContain("Join A&amp;B &lt;app&gt;");
  });

  describe("with an Email style", () => {
    const style = (accentColor: string): ResolvedEmailStyle => ({
      logo: null,
      name: null,
      altName: "Fernlight",
      headerColor: "#0b1f3a",
      accentColor,
    });
    const render = (s?: ResolvedEmailStyle | null) =>
      renderInviteEmail({ ...defaultInviteCopy("en"), merge, inviteUrl: URL_, productName: "Fernlight", expiresInDays: 30, style: s });
    const button = (html: string) => html.match(/<a href="https:\/\/waitlist\.example\.com\/invite\/[^"]*"[^>]*>/)?.[0] ?? "";

    it("adds the band and gives the button the button colour, with a readable label", () => {
      const dark = render(style("#1d4ed8"));
      expect(dark.html).toContain('bgcolor="#0b1f3a"');
      expect(button(dark.html)).toContain("background:#1d4ed8;color:#ffffff;");
      expect(button(render(style("#ffd400")).html)).toContain("background:#ffd400;color:#000000;");
      // The link and the text part don't change.
      expect(dark.text).toBe(render().text);
    });

    it("leads with its opening words, the button read as its label, so the band isn't the inbox snippet", () => {
      const { html } = render(style("#1d4ed8"));
      const hidden = html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/)?.[1] ?? "";
      expect(hidden).toMatch(/^Hi Amara &lt;b&gt;, Thanks for waiting\. Fernlight is ready/);
      expect(hidden).toContain("invited in. Join Fernlight");
      expect(html.indexOf("display:none")).toBeLessThan(html.indexOf('bgcolor="#0b1f3a"'));
      // The link stays in the button alone: never a hidden copy in the preheader.
      expect(html.match(/href="https:\/\/waitlist\.example\.com\/invite\//g)).toHaveLength(1);
      expect(html).not.toMatch(/YGINV1/);
    });

    it("no style (null or absent) keeps today's #111 button", () => {
      expect(render(null)).toEqual(render());
      expect(button(render().html)).toContain("background:#111;color:#fff;");
    });
  });

  // Pinned byte-for-byte: with no Email style saved, invites must stay exactly this.
  it("pins today's html and text for the default copy", () => {
    const { subject, body } = defaultInviteCopy("en");
    const out = renderInviteEmail({
      subject,
      body,
      merge: {
        ...merge,
        signup: { id: "sig_2", firstName: "Amara", email: "amara@example.test" } as Signup,
        footer: {
          brand: "Fernlight",
          unsubscribeUrl: "https://waitlist.example.com/unsubscribe?u=t",
          managePreferencesUrl: "https://waitlist.example.com/preferences?u=t",
          privacyUrl: "https://example.com/privacy",
        },
      },
      inviteUrl: URL_,
      productName: "Fernlight",
      expiresInDays: 30,
      locale: "en",
    });
    expect(out.html).toMatchInlineSnapshot(`
      "<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f6f6f6">
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
          
          <p>Hi Amara,</p>
      <p>Thanks for waiting. Fernlight is ready, and as one of the first on the Fernlight list, you&#39;re invited in.</p>
      <p><a href="https://waitlist.example.com/invite/abc.def" target="_blank" rel="noopener noreferrer" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Join Fernlight</a></p>
      <p>Your invite link works for 30 days.</p><div data-vzb-footer="1" style="text-align:center;margin:28px 0 0;padding-top:20px;border-top:1px solid #ededed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.7;color:#999999">This email was sent by Fernlight.<br /><a href="https://waitlist.example.com/preferences?u=t" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Manage preferences</a> &nbsp;|&nbsp; <a href="https://waitlist.example.com/unsubscribe?u=t" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Unsubscribe</a> &nbsp;|&nbsp; <a href="https://example.com/privacy" mc:disable-tracking target="_blank" rel="noopener noreferrer" style="color:#999999;text-decoration:underline">Privacy Policy</a></div>
        </div>
      </body></html>"
    `);
    expect(out.text).toMatchInlineSnapshot(`
      "Hi Amara,

      Thanks for waiting. Fernlight is ready, and as one of the first on the Fernlight list, you're invited in.

      https://waitlist.example.com/invite/abc.def

      Your invite link works for 30 days.
      This email was sent by Fernlight.
      Manage preferences (https://waitlist.example.com/preferences?u=t) | Unsubscribe (https://waitlist.example.com/unsubscribe?u=t) | Privacy Policy (https://example.com/privacy)"
    `);
  });
});
