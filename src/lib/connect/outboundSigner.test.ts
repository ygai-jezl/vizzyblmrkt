import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  __setSigningKeySource,
  kmsKeySource,
  outboundIssuer,
  publishedJwks,
  signOutboundRequest,
  signingKeySource,
  OutboundSigningUnavailable,
  PUBLISH_BEFORE_USE_MS,
} from "./outboundSigner";
import { bearerToken, crc32c, outboundClaims, signingInput, verifyOutboundToken } from "./outboundToken";

const KEY = "projects/p/locations/us-central1/keyRings/yougrow-connect/cryptoKeys/outbound-signing";
const NOW = Date.parse("2026-09-22T12:00:00Z");

interface FakeVersion {
  id: string;
  createTime: string;
  key: KeyObject;
  algorithm?: string;
}

/** A stand-in for the Cloud KMS REST API, signing with real local keys. */
function fakeKms(versions: FakeVersion[], tamper: { sign?: "name" | "crc" | "unverified"; pemCrc?: boolean } = {}) {
  const calls: string[] = [];
  const byName = new Map(versions.map((v) => [`${KEY}/cryptoKeyVersions/${v.id}`, v]));
  const request = async <T,>(opts: { url: string; method?: string; data?: unknown }): Promise<T> => {
    calls.push(opts.url);
    const path = opts.url.replace("https://cloudkms.googleapis.com/v1/", "");
    if (path.startsWith(`${KEY}/cryptoKeyVersions?`)) {
      return {
        cryptoKeyVersions: versions.map((v) => ({
          name: `${KEY}/cryptoKeyVersions/${v.id}`,
          state: "ENABLED",
          algorithm: v.algorithm ?? "EC_SIGN_P256_SHA256",
          createTime: v.createTime,
        })),
      } as T;
    }
    if (path.endsWith("/publicKey")) {
      const name = path.slice(0, -"/publicKey".length);
      const v = byName.get(name)!;
      const pub = createPublicKey(v.key).export({ format: "pem", type: "spki" }).toString();
      return { name, pem: pub, algorithm: v.algorithm ?? "EC_SIGN_P256_SHA256", pemCrc32c: String(crc32c(Buffer.from(pub)) + (tamper.pemCrc ? 1 : 0)) } as T;
    }
    if (path.endsWith(":asymmetricSign")) {
      const name = path.slice(0, -":asymmetricSign".length);
      const v = byName.get(name)!;
      const data = opts.data as { digest: { sha256: string }; digestCrc32c: string };
      const digest = Buffer.from(data.digest.sha256, "base64");
      expect(Number(data.digestCrc32c)).toBe(crc32c(digest));
      // KMS returns DER-encoded ECDSA signatures.
      const der = signDigest(v.key, digest);
      return {
        name: tamper.sign === "name" ? `${KEY}/cryptoKeyVersions/999` : name,
        signature: der.toString("base64"),
        signatureCrc32c: String(crc32c(der) + (tamper.sign === "crc" ? 1 : 0)),
        verifiedDigestCrc32c: tamper.sign !== "unverified",
      } as T;
    }
    throw new Error(`unexpected ${opts.url}`);
  };
  return { request, calls };
}

/**
 * Cloud KMS signs a SHA-256 digest; Node can only sign whole messages. So each
 * test registers the messages it expects to be signed, keyed by digest.
 */
const expected = new Map<string, Buffer>();
function willSign(message: string | Buffer): void {
  const m = Buffer.from(message);
  expected.set(createHash("sha256").update(m).digest("hex"), m);
}
function signDigest(key: KeyObject, digest: Buffer): Buffer {
  const msg = expected.get(digest.toString("hex"));
  if (!msg) throw new Error("fake kms: unexpected digest");
  return sign("sha256", msg, { key, dsaEncoding: "der" });
}

const newKey = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  __setSigningKeySource(null);
  vi.unstubAllEnvs();
});

describe("kmsKeySource", () => {
  it("publishes every enabled P-256 version and signs tokens that verify against them", async () => {
    const kms = fakeKms([
      { id: "1", createTime: iso(NOW - 30 * 86400_000), key: newKey() },
      { id: "2", createTime: iso(NOW - 3600_000), key: newKey() },
      { id: "3", createTime: iso(NOW - 3600_000), key: newKey(), algorithm: "RSA_SIGN_PSS_2048_SHA256" },
    ]);
    const src = kmsKeySource(KEY, kms.request);
    __setSigningKeySource(src);
    vi.stubEnv("CONNECT_ISSUER", "https://yougrow.test");

    const jwks = await publishedJwks();
    expect(jwks).toHaveLength(2);

    const body = '{"userId":"u1","purpose":"send","requestId":"r1"}';
    const signer = await src.signer(NOW);
    willSign(signingInput(signer.kid, outboundClaims({ issuer: "https://yougrow.test", audience: "ygk_a", direction: "context", jti: "r1", rawBody: body, nowMs: NOW })));
    const h = await signOutboundRequest({ audience: "ygk_a", direction: "context", jti: "r1", rawBody: body, nowMs: NOW });
    const r = verifyOutboundToken({
      token: bearerToken(h.authorization),
      jwks,
      issuer: "https://yougrow.test",
      audience: "ygk_a",
      direction: "context",
      rawBody: body,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(h["x-yougrow-key-id"]).toBe("ygk_a");
  });

  it("signs with a new version only once it has been published for a day", async () => {
    const old = { id: "1", createTime: iso(NOW - 90 * 86400_000), key: newKey() };
    const fresh = { id: "2", createTime: iso(NOW - PUBLISH_BEFORE_USE_MS + 60_000), key: newKey() };
    const src = kmsKeySource(KEY, fakeKms([old, fresh]).request);
    const [freshJwk, oldJwk] = await src.publicKeys();
    expect((await src.signer(NOW)).kid).toBe(oldJwk!.kid);
    expect((await src.signer(NOW + 120_000)).kid).toBe(freshJwk!.kid);
  });

  it("uses the only version at first setup, even if brand new", async () => {
    const src = kmsKeySource(KEY, fakeKms([{ id: "1", createTime: iso(NOW - 60_000), key: newKey() }]).request);
    const [only] = await src.publicKeys();
    expect((await src.signer(NOW)).kid).toBe(only!.kid);
  });

  it.each(["name", "crc", "unverified"] as const)("refuses a sign response failing the %s integrity check", async (t) => {
    const src = kmsKeySource(KEY, fakeKms([{ id: "1", createTime: iso(NOW - 90 * 86400_000), key: newKey() }], { sign: t }).request);
    const s = await src.signer(NOW);
    willSign("x");
    await expect(s.sign(Buffer.from("x"))).rejects.toThrow(/kms_integrity/);
  });

  it("refuses a corrupted public key", async () => {
    const src = kmsKeySource(KEY, fakeKms([{ id: "1", createTime: iso(NOW), key: newKey() }], { pemCrc: true }).request);
    await expect(src.publicKeys()).rejects.toThrow(/kms_public_key_crc/);
  });

  it("has nothing to sign with when no version is enabled", async () => {
    const src = kmsKeySource(KEY, fakeKms([]).request);
    await expect(src.signer(NOW)).rejects.toThrow(/no_enabled_key_version/);
  });
});

describe("configuration", () => {
  it("never falls back to a local key in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONNECT_SIGNING_KMS_KEY", "");
    expect(() => signingKeySource()).toThrow(OutboundSigningUnavailable);
    vi.stubEnv("CONNECT_ISSUER", "");
    expect(() => outboundIssuer()).toThrow(/issuer_unconfigured/);
    vi.stubEnv("CONNECT_ISSUER", "http://yougrow.ai");
    expect(() => outboundIssuer()).toThrow(/issuer_not_https/);
  });

  it("rejects a malformed KMS key name", () => {
    vi.stubEnv("CONNECT_SIGNING_KMS_KEY", "my-key");
    expect(() => signingKeySource()).toThrow(/bad_kms_key_name/);
  });

  it("signs with an ephemeral key in local dev and tests", async () => {
    vi.stubEnv("CONNECT_SIGNING_KMS_KEY", "");
    vi.stubEnv("CONNECT_ISSUER", "");
    const body = "{}";
    const h = await signOutboundRequest({ audience: "ygk_b", direction: "webhook", jti: "wh_1", rawBody: body, nowMs: NOW });
    const r = verifyOutboundToken({
      token: bearerToken(h.authorization),
      jwks: await publishedJwks(),
      issuer: "http://localhost:3000",
      audience: "ygk_b",
      direction: "webhook",
      rawBody: body,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
  });
});
