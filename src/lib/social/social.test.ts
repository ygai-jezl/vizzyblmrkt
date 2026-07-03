import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  encryptToken,
  decryptToken,
  signState,
  verifyState,
  isSocialCryptoConfigured,
} from "./crypto";
import {
  generatePkce,
  buildXAuthorizeUrl,
  basicAuthHeader,
  isXConfigured,
  X_SCOPES,
} from "./x/oauth";
import { getDecryptedSocialTokens } from "./connections";
import { SocialConnectionSchema, type Tenant } from "@/lib/types/tenant";
import { z } from "zod";

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.SOCIAL_TOKEN_ENC_KEY = "test-social-root-key-0123456789abcdef";
  process.env.X_OAUTH_CLIENT_ID = "cid";
  process.env.X_OAUTH_CLIENT_SECRET = "csecret";
});
afterAll(() => {
  process.env = savedEnv;
});

describe("social crypto", () => {
  it("round-trips a token through AES-256-GCM", () => {
    const blob = encryptToken("super-secret-access-token");
    expect(blob.ct).not.toContain("super-secret");
    expect(decryptToken(blob)).toBe("super-secret-access-token");
  });

  it("signs + verifies a state, and rejects tampering", () => {
    const token = signState({ t: "ten_1", p: "x", ts: 123 });
    expect(verifyState(token)).toMatchObject({ t: "ten_1", p: "x", ts: 123 });
    expect(verifyState(token.slice(0, -2) + "xy")).toBeNull(); // bad signature
    expect(verifyState("garbage")).toBeNull();
  });

  it("fails closed (null) when the root key is unset", () => {
    const key = process.env.SOCIAL_TOKEN_ENC_KEY;
    delete process.env.SOCIAL_TOKEN_ENC_KEY;
    expect(isSocialCryptoConfigured()).toBe(false);
    expect(verifyState(signStateWith(key!))).toBeNull();
    process.env.SOCIAL_TOKEN_ENC_KEY = key;
  });
});

/** Sign a state while the key is present, then the caller unsets it to test verify. */
function signStateWith(key: string): string {
  process.env.SOCIAL_TOKEN_ENC_KEY = key;
  const t = signState({ t: "ten_1", p: "x", ts: 1 });
  delete process.env.SOCIAL_TOKEN_ENC_KEY;
  return t;
}

describe("X OAuth helpers", () => {
  it("generates a PKCE pair whose challenge is S256(verifier)", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(generatePkce().verifier).not.toBe(verifier); // random each call
  });

  it("builds an authorize URL with response_type, PKCE, scope + state", () => {
    const url = new URL(
      buildXAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://app.example/api/admin/integrations/x/callback",
        state: "st",
        codeChallenge: "chal",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(X_SCOPES);
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("basicAuthHeader base64-encodes id:secret; isXConfigured reflects env", () => {
    expect(basicAuthHeader("id", "sec")).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(isXConfigured()).toBe(true);
  });
});

describe("getDecryptedSocialTokens", () => {
  function tenantWithX(): Tenant {
    return {
      socialConnections: {
        x: {
          platform: "x",
          enc: encryptToken("acc-token"),
          refreshEnc: encryptToken("ref-token"),
          handle: "myhandle",
          expiresAt: "2026-01-01T00:00:00.000Z",
          connectedAt: "2025-01-01T00:00:00.000Z",
        },
      },
    } as unknown as Tenant;
  }

  it("decrypts stored access + refresh tokens + handle", () => {
    const t = getDecryptedSocialTokens(tenantWithX(), "x");
    expect(t).toEqual({
      accessToken: "acc-token",
      refreshToken: "ref-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
      handle: "myhandle",
    });
  });

  it("returns null when not connected", () => {
    expect(getDecryptedSocialTokens({} as Tenant, "x")).toBeNull();
    expect(getDecryptedSocialTokens(null, "x")).toBeNull();
  });

  it("returns null (fail-soft) when the crypto key is unset", () => {
    const t = tenantWithX();
    const key = process.env.SOCIAL_TOKEN_ENC_KEY;
    delete process.env.SOCIAL_TOKEN_ENC_KEY;
    expect(getDecryptedSocialTokens(t, "x")).toBeNull();
    process.env.SOCIAL_TOKEN_ENC_KEY = key;
  });

  it("returns null (fail-soft) when a stored blob is tampered (GCM tag mismatch)", () => {
    const t = tenantWithX();
    // Corrupt the ciphertext → GCM auth fails → decryptToken throws → caught → null.
    t.socialConnections!.x!.enc.ct = "0000" + t.socialConnections!.x!.enc.ct.slice(4);
    expect(getDecryptedSocialTokens(t, "x")).toBeNull();
  });
});

describe("SocialConnectionSchema", () => {
  it("parses a connection with only the required fields (rest optional)", () => {
    const c = SocialConnectionSchema.parse({
      platform: "x",
      enc: { ct: "a", iv: "b", tag: "c" },
      connectedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(c.platform).toBe("x");
    expect(c.refreshEnc).toBeUndefined();
  });

  it("parses a socialConnections record with ONLY x present", () => {
    const rec = z.record(z.string(), SocialConnectionSchema).parse({
      x: { platform: "x", enc: { ct: "a", iv: "b", tag: "c" }, connectedAt: "t" },
    });
    expect(Object.keys(rec)).toEqual(["x"]);
  });
});
