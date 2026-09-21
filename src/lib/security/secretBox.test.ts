import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSecretBox, type EncryptedBlob } from "./secretBox";

const ENV = "SECRET_BOX_TEST_KEY";
const box = createSecretBox({
  envVar: ENV,
  encPurpose: "test-enc-v1",
  statePurpose: "test-state-v1",
  unconfiguredError: "test_key_unconfigured",
});

/** The pre-factory algorithm, verbatim — proves stored ciphertexts still open. */
function legacySeal(root: string, purpose: string, plaintext: string): EncryptedBlob {
  const rootKey = createHash("sha256").update(root).digest();
  const key = createHmac("sha256", rootKey).update(purpose).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function legacyState(root: string, purpose: string, payload: Record<string, unknown>): string {
  const rootKey = createHash("sha256").update(root).digest();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", createHmac("sha256", rootKey).update(purpose).digest())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

describe("createSecretBox", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    process.env[ENV] = "unit-test-root-key-please-rotate";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("opens ciphertext sealed by the pre-factory algorithm (byte-compatible)", () => {
    const blob = legacySeal("unit-test-root-key-please-rotate", "test-enc-v1", "ghp_token");
    expect(box.open(blob)).toBe("ghp_token");
  });

  it("verifies state signed by the pre-factory algorithm", () => {
    const token = legacyState("unit-test-root-key-please-rotate", "test-state-v1", { t: "ten_x" });
    expect(box.verifyState(token)).toEqual({ t: "ten_x" });
  });

  it("round-trips with and without AAD", () => {
    expect(box.open(box.seal("s3cret"))).toBe("s3cret");
    expect(box.open(box.seal("s3cret", "ten_a:pcn_1"), "ten_a:pcn_1")).toBe("s3cret");
  });

  it("refuses to open a blob under a different AAD, or with AAD added or dropped", () => {
    const bound = box.seal("s3cret", "ten_a:pcn_1");
    expect(() => box.open(bound, "ten_b:pcn_1")).toThrow();
    expect(() => box.open(bound)).toThrow();
    expect(() => box.open(box.seal("s3cret"), "ten_a:pcn_1")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const blob = box.seal("hello", "ctx");
    const bytes = [...Buffer.from(blob.ct, "base64")];
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => box.open({ ...blob, ct: Buffer.from(bytes).toString("base64") }, "ctx")).toThrow();
  });

  it("keeps boxes with different purposes apart", () => {
    const other = createSecretBox({
      envVar: ENV,
      encPurpose: "other-enc-v1",
      statePurpose: "other-state-v1",
      unconfiguredError: "x",
    });
    expect(() => other.open(box.seal("s3cret"))).toThrow();
    expect(other.verifyState(box.signState({ t: 1 }))).toBeNull();
  });

  it("fails closed when the root key is unset", () => {
    const token = box.signState({ t: 1 });
    delete process.env[ENV];
    expect(box.isConfigured()).toBe(false);
    expect(() => box.seal("x")).toThrow("test_key_unconfigured");
    expect(box.verifyState(token)).toBeNull();
  });
});
