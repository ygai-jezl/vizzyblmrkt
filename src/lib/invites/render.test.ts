import { describe, expect, it } from "vitest";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
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
});
