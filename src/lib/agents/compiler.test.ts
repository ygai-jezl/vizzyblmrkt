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
});
