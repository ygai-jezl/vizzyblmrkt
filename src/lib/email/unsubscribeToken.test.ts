import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribeToken";

const input = {
  tenantId: "ten_a",
  campaignId: "camp1",
  signupId: "sig_1",
  email: "Jo@Acme.com",
};

describe("unsubscribeToken", () => {
  beforeEach(() => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
  });

  it("round-trips claims and normalizes the email", () => {
    const token = signUnsubscribeToken(input);
    const res = verifyUnsubscribeToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.tenantId).toBe("ten_a");
      expect(res.claims.signupId).toBe("sig_1");
      expect(res.claims.email).toBe("jo@acme.com"); // lowercased at mint
    }
  });

  it("rejects a tampered payload (bad signature)", () => {
    const token = signUnsubscribeToken(input);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...input, tenantId: "ten_evil", email: "jo@acme.com", iat: 0 }),
    ).toString("base64url");
    const res = verifyUnsubscribeToken(`${forged}.${sig}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bad_signature");
    // sanity: the untampered token still verifies
    expect(verifyUnsubscribeToken(`${payload}.${sig}`).ok).toBe(true);
  });

  it("rejects a token signed with a different key", () => {
    const token = signUnsubscribeToken(input);
    process.env.UNSUBSCRIBE_SIGNING_KEY = "rotated-key";
    const res = verifyUnsubscribeToken(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bad_signature");
  });

  it("rejects malformed tokens", () => {
    expect(verifyUnsubscribeToken("").ok).toBe(false);
    expect(verifyUnsubscribeToken("no-dot").ok).toBe(false);
    expect(verifyUnsubscribeToken(".").ok).toBe(false);
  });
});
