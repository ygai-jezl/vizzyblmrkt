import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONNECT_REASONS, connectErrorMessage } from "./connectErrors";

// Every reason a connect route sends back has its own message that names the right service.
describe("connectErrorMessage", () => {
  it.each(CONNECT_REASONS.map((r) => [r]))("%s has its own message", (reason) => {
    const msg = connectErrorMessage(reason, "LinkedIn");
    expect(msg).not.toBe(connectErrorMessage("some_new_reason", "LinkedIn"));
    expect(msg).not.toContain("(");
    expect(msg).toMatch(/^[A-Z]/);
  });

  it("names the service the attempt was for", () => {
    expect(connectErrorMessage("token_exchange_failed", "LinkedIn")).toBe(
      "LinkedIn didn't confirm the connection. Please try again.",
    );
    expect(connectErrorMessage("token_exchange_failed", "GitLab")).toBe("GitLab didn't confirm the connection. Please try again.");
    for (const r of ["access_denied", "user_cancelled_login", "user_cancelled_authorize"]) {
      expect(connectErrorMessage(r, "LinkedIn Pages")).toBe("The connection was cancelled on LinkedIn Pages.");
    }
  });

  it("says only admins connect", () => {
    expect(connectErrorMessage("forbidden", "GitHub")).toBe("Only admins can connect accounts. Ask an admin on your team.");
  });

  it("reuses the not set up line for a service without app keys", () => {
    for (const r of ["x_not_configured", "linkedin_not_configured", "linkedin_cm_not_configured"]) {
      expect(connectErrorMessage(r, "X (Twitter)")).toBe(
        "Not set up on this YouGrow yet. Whoever runs it can add its app keys.",
      );
    }
  });

  it("falls back to the reason, and to 'the service' with no label", () => {
    expect(connectErrorMessage("some_new_reason", "X (Twitter)")).toBe("Couldn't connect X (Twitter) (some_new_reason).");
    expect(connectErrorMessage("some_new_reason")).toBe("Couldn't connect the service (some_new_reason).");
    expect(connectErrorMessage("token_exchange_failed", "")).toBe("The service didn't confirm the connection. Please try again.");
  });

  it("follows the house style: no dashes, no AI tells", () => {
    for (const r of CONNECT_REASONS) {
      const msg = connectErrorMessage(r, "GitHub");
      expect(dashesIn(msg), `${r}: ${msg}`).toEqual([]);
      expect(aiTellsIn(msg), `${r}: ${msg}`).toEqual([]);
    }
  });
});
