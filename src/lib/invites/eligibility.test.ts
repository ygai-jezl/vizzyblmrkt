import { describe, expect, it } from "vitest";
import { hasValidSignupUrl, inviteConnections, inviteLock, inviteProductName, type InviteConnection } from "./eligibility";

const conn = (over: Partial<InviteConnection> = {}): InviteConnection => ({
  id: "pcn_1",
  name: "Fernlight",
  kind: "custom",
  status: "active",
  environment: "production",
  signupUrl: "https://app.fernlight.test/signup",
  linkDomains: ["fernlight.test"],
  ...over,
});

describe("invite eligibility", () => {
  it("only live, non-staging, custom products with a valid sign-up link qualify", () => {
    const ok = conn();
    const cases = [
      conn({ id: "sandbox", kind: "sandbox" }),
      conn({ id: "paused", status: "paused" }),
      conn({ id: "staging", environment: "staging" }),
      conn({ id: "named-staging", environment: null, name: "Fernlight (staging)" }),
      conn({ id: "no-url", signupUrl: null }),
      conn({ id: "http", signupUrl: "http://app.fernlight.test/signup" }),
      conn({ id: "other-domain", signupUrl: "https://evil.test/signup" }),
    ];
    expect(inviteConnections([ok, ...cases]).map((c) => c.id)).toEqual(["pcn_1"]);
    // An unlabelled connection counts as production.
    expect(inviteConnections([conn({ environment: null })])).toHaveLength(1);
    expect(hasValidSignupUrl({ signupUrl: "https://a.fernlight.test/x", linkDomains: ["fernlight.test"] })).toBe(true);
  });

  it("locks with the first reason that applies", () => {
    const base = { archived: false, keyConfigured: true };
    expect(inviteLock({ ...base, archived: true, connections: [conn()] })).toBe("launch_archived");
    expect(inviteLock({ ...base, connections: [] })).toBe("no_product");
    expect(inviteLock({ ...base, connections: [conn({ kind: "sandbox" })] })).toBe("no_product");
    expect(inviteLock({ ...base, connections: [conn({ environment: "staging" })] })).toBe("staging_only");
    expect(inviteLock({ ...base, connections: [conn({ signupUrl: null })] })).toBe("no_signup_url");
    expect(inviteLock({ ...base, keyConfigured: false, connections: [conn()] })).toBe("links_unconfigured");
    expect(inviteLock({ ...base, connections: [conn({ environment: "staging" }), conn({ id: "p" })] })).toBeNull();
  });

  it("names the product without its environment suffix", () => {
    expect(inviteProductName({ name: "Fernlight (production)", environment: null })).toBe("Fernlight");
  });
});
