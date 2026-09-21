import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mintUnsubscribeTokenV2OrNull,
  signUnsubscribeToken,
  signUnsubscribeTokenV2,
  verifyUnsubscribeToken,
  verifyUnsubscribeTokenAny,
} from "./unsubscribeToken";

const v2 = {
  tenantId: "ten_a",
  email: "Alex@Acme.test",
  recipientId: "pu_abc",
  connectionId: "pcn_1",
  category: "onboarding",
  categoryLabel: "Onboarding tips",
};

describe("unsubscribe token v2 (lifecycle)", () => {
  beforeEach(() => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    vi.unstubAllEnvs();
  });

  it("round-trips through the any-version verifier", () => {
    const res = verifyUnsubscribeTokenAny(signUnsubscribeTokenV2(v2));
    expect(res.ok).toBe(true);
    if (res.ok && res.version === 2) {
      expect(res.claims).toMatchObject({
        v: 2,
        tenantId: "ten_a",
        email: "alex@acme.test",
        recipientKind: "product_user",
        recipientId: "pu_abc",
        connectionId: "pcn_1",
        category: "onboarding",
        categoryLabel: "Onboarding tips",
      });
    } else {
      throw new Error("expected a v2 result");
    }
  });

  it("is refused by the v1-only verifier, so no older path treats it as tenant-wide", () => {
    const res = verifyUnsubscribeToken(signUnsubscribeTokenV2(v2));
    expect(res).toEqual({ ok: false, error: "invalid_claims" });
  });

  it("the any-version verifier still accepts v1 tokens", () => {
    const res = verifyUnsubscribeTokenAny(
      signUnsubscribeToken({ tenantId: "ten_a", campaignId: "c1", signupId: "s1", email: "jo@acme.test" }),
    );
    expect(res.ok && res.version).toBe(1);
  });

  it("rejects a tampered v2 payload", () => {
    const token = signUnsubscribeTokenV2(v2);
    const sig = token.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ ...v2, v: 2, recipientKind: "product_user", tenantId: "ten_evil", iat: 0 })).toString(
      "base64url",
    );
    expect(verifyUnsubscribeTokenAny(`${forged}.${sig}`)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a correctly signed v2 token with an invalid category", () => {
    const res = verifyUnsubscribeTokenAny(signUnsubscribeTokenV2({ ...v2, category: "Not A Slug!" }));
    expect(res).toEqual({ ok: false, error: "invalid_claims" });
  });

  it("caps the category label", () => {
    const res = verifyUnsubscribeTokenAny(signUnsubscribeTokenV2({ ...v2, categoryLabel: "x".repeat(200) }));
    expect(res.ok && res.version === 2 && res.claims.categoryLabel.length).toBe(80);
  });

  it("mints nothing in production without a signing key", () => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    vi.stubEnv("NODE_ENV", "production");
    expect(mintUnsubscribeTokenV2OrNull(v2)).toBeNull();
  });
});
