import { describe, it, expect } from "vitest";
import { renderMergeVars, toMailchimpMergeTags } from "./mergeVars";
import type { Signup } from "@/lib/types/signup";
import { resolveProductName, type Campaign } from "@/lib/types/campaign";

const signup = {
  firstName: "Ada",
  lastName: "Lovelace",
  referralLink: "https://x.test/r/abc",
  amountReferred: 3,
  metadata: { company: "Analytical Engines" },
} as unknown as Signup;

const campaign = { waitlistName: "Beta" } as unknown as Campaign;

// A launch whose headline is a call-to-action; the founder set a clean product
// name for copy. {{waitlist_name}} must resolve to the product name, not the H1.
const ctaCampaign = {
  waitlistName: "Be the first to get access",
  productName: "Acme Beta",
} as unknown as Campaign;

describe("renderMergeVars (journey / per-recipient)", () => {
  it("resolves built-in vars including current_rank", () => {
    const out = renderMergeVars(
      "Hi {{first_name}} {{last_name}}, #{{current_rank}} with {{referral_count}} refs → {{referral_link}}",
      { signup, campaign, rank: 7 },
    );
    expect(out).toBe(
      "Hi Ada Lovelace, #7 with 3 refs → https://x.test/r/abc",
    );
  });

  it("resolves metadata.* and waitlist_name, blanks unknown/missing", () => {
    expect(
      renderMergeVars("{{metadata.company}} / {{waitlist_name}} / {{nope}}", {
        signup,
        campaign,
      }),
    ).toBe("Analytical Engines / Beta / ");
  });

  it("resolves waitlist_name to productName when set (not the headline)", () => {
    expect(
      renderMergeVars("Thanks for joining {{waitlist_name}}!", {
        signup,
        campaign: ctaCampaign,
      }),
    ).toBe("Thanks for joining Acme Beta!");
  });

  it("falls back to waitlistName when productName is blank/absent", () => {
    expect(
      renderMergeVars("Joining {{waitlist_name}}", {
        signup,
        campaign: { waitlistName: "Beta", productName: "  " } as unknown as Campaign,
      }),
    ).toBe("Joining Beta");
  });

  it("leaves current_rank blank when rank is unknown", () => {
    expect(renderMergeVars("#{{current_rank}}", { signup, campaign })).toBe("#");
  });

  it("escapes only the substituted value when an escape fn is given", () => {
    const evil = { firstName: "<b>x</b>", amountReferred: 0 } as unknown as Signup;
    const esc = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(
      renderMergeVars("<p>Hi {{first_name}}</p>", { signup: evil, campaign }, esc),
    ).toBe("<p>Hi &lt;b&gt;x&lt;/b&gt;</p>");
  });
});

describe("resolveProductName", () => {
  it("prefers productName, falls back to waitlistName when blank/absent", () => {
    expect(resolveProductName({ productName: "Acme Beta", waitlistName: "H1" })).toBe("Acme Beta");
    expect(resolveProductName({ productName: "  ", waitlistName: "H1" })).toBe("H1");
    expect(resolveProductName({ waitlistName: "H1" } as Campaign)).toBe("H1");
  });
});

describe("toMailchimpMergeTags (broadcast)", () => {
  it("maps supported vars to MailChimp tags and inlines waitlist_name", () => {
    expect(
      toMailchimpMergeTags(
        "Hi {{first_name}} on {{waitlist_name}}: {{referral_link}}",
        campaign,
      ),
    ).toBe("Hi *|FNAME|* on Beta: *|REFLINK|*");
  });

  it("inlines productName for waitlist_name when set (not the headline)", () => {
    expect(
      toMailchimpMergeTags("Hi {{first_name}} on {{waitlist_name}}", ctaCampaign),
    ).toBe("Hi *|FNAME|* on Acme Beta");
  });

  it("blanks current_rank and metadata (not available list-side)", () => {
    expect(
      toMailchimpMergeTags("#{{current_rank}} {{metadata.company}}", campaign),
    ).toBe("# ");
  });
});
