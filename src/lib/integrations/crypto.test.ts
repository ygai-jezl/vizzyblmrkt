import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptToken,
  decryptToken,
  signState,
  verifyState,
  isGitCryptoConfigured,
} from "./crypto";

beforeAll(() => {
  process.env.GIT_TOKEN_ENC_KEY = "unit-test-root-key-please-rotate";
});

describe("git integration crypto", () => {
  it("round-trips a token and never stores plaintext", () => {
    const blob = encryptToken("ghp_supersecrettoken");
    expect(blob.ct).not.toContain("ghp_");
    expect(decryptToken(blob)).toBe("ghp_supersecrettoken");
  });

  it("uses a fresh IV per encryption (no nonce reuse)", () => {
    expect(encryptToken("x").iv).not.toBe(encryptToken("x").iv);
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const blob = encryptToken("hello");
    const bytes = [...Buffer.from(blob.ct, "base64")];
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const corrupt = { ...blob, ct: Buffer.from(bytes).toString("base64") };
    expect(() => decryptToken(corrupt)).toThrow();
  });

  it("signs and verifies a tenant-bound state", () => {
    const s = signState({ t: "ten_x", p: "github", ts: 123 });
    expect(verifyState(s)).toMatchObject({ t: "ten_x", p: "github", ts: 123 });
  });

  it("rejects tampered / malformed state", () => {
    const s = signState({ t: "ten_x" });
    expect(verifyState(`${s}x`)).toBeNull();
    expect(verifyState("garbage")).toBeNull();
    expect(verifyState("")).toBeNull();
  });

  it("reports configured when the root key is present", () => {
    expect(isGitCryptoConfigured()).toBe(true);
  });

  it("verifyState fails closed (null, not throw) when the key is rotated away", () => {
    const saved = process.env.GIT_TOKEN_ENC_KEY;
    const s = signState({ t: "ten_x", ts: 1 });
    delete process.env.GIT_TOKEN_ENC_KEY;
    expect(isGitCryptoConfigured()).toBe(false);
    expect(verifyState(s)).toBeNull();
    process.env.GIT_TOKEN_ENC_KEY = saved;
  });
});
