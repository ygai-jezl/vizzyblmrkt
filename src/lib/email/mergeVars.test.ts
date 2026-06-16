import { describe, it, expect } from "vitest";
import { renderMergeVars, toMailchimpMergeTags } from "./mergeVars";
import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";

const signup = {
  firstName: "Ada",
  lastName: "Lovelace",
  referralLink: "https://x.test/r/abc",
  amountReferred: 3,
  metadata: { company: "Analytical Engines" },
} as unknown as Signup;

const campaign = { waitlistName: "Beta" } as unknown as Campaign;

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

describe("toMailchimpMergeTags (broadcast)", () => {
  it("maps supported vars to MailChimp tags and inlines waitlist_name", () => {
    expect(
      toMailchimpMergeTags(
        "Hi {{first_name}} on {{waitlist_name}}: {{referral_link}}",
        campaign,
      ),
    ).toBe("Hi *|FNAME|* on Beta: *|REFLINK|*");
  });

  it("blanks current_rank and metadata (not available list-side)", () => {
    expect(
      toMailchimpMergeTags("#{{current_rank}} {{metadata.company}}", campaign),
    ).toBe("# ");
  });
});
