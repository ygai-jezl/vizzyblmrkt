import { describe, it, expect } from "vitest";
import { compileJourneyEmail, compileBroadcast } from "./compiler";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";

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
