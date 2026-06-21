import { describe, it, expect } from "vitest";
import {
  offboardingEmail,
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
