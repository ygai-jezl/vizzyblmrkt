import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicKey } from "node:crypto";
import {
  currentLicence,
  licenceKeySetting,
  MAX_LICENCE_KEY_LENGTH,
  okpThumbprint,
  verifyLicenceKey,
  type LicenceResult,
} from "./licence";
import { LICENCE_PUBLIC_KEYS } from "./publicKeys";
import { goodClaims, makeLicenceKeyPair } from "./testing/licence";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const NOW_SEC = Math.floor(NOW / 1000);
const pair = makeLicenceKeyPair();
const other = makeLicenceKeyPair();
const KEYS = [pair.publicJwk];

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64url");
const reasonOf = (r: LicenceResult) => (r.ok ? "ok" : r.reason);
const verify = (key: string | null | undefined, nowMs = NOW) => verifyLicenceKey({ key, keys: KEYS, nowMs });

const good = pair.mint(goodClaims(NOW));
const [h, p, s] = good.slice("ygel_".length).split(".") as [string, string, string];

/** A part made one character longer so its length mod 4 is 1: never canonical base64url. */
function lengthMod1(part: string): string {
  const add = ((1 - (part.length % 4)) + 4) % 4 || 4;
  return part + "A".repeat(add);
}

/** The same bytes, but the unused low bits of the last character set: Buffer accepts it. */
function strayBits(part: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(part.at(-1)!);
  return part.slice(0, -1) + alphabet[last + 1];
}

function flipByte(part: string, at: number): string {
  const bytes = Buffer.from(part, "base64url");
  bytes[at] = bytes[at]! ^ 0x01;
  return bytes.toString("base64url");
}

describe("verifyLicenceKey", () => {
  it("accepts a good key and returns its claims", () => {
    const r = verify(good);
    expect(r).toEqual({ ok: true, claims: goodClaims(NOW) });
    expect(r.ok && Object.isFrozen(r.claims) && Object.isFrozen(r.claims.features)).toBe(true);
  });

  it("ignores spaces around the key", () => {
    expect(reasonOf(verify(`  ${good}\n`))).toBe("ok");
  });

  it("keeps feature ids it doesn't know, for keys from a newer copy", () => {
    const r = verify(pair.mint(goodClaims(NOW, { features: ["sso", "something_new"] })));
    expect(r.ok && r.claims.features).toEqual(["sso", "something_new"]);
  });

  it("accepts a start time inside the leeway", () => {
    expect(reasonOf(verify(pair.mint(goodClaims(NOW, { nbf: NOW_SEC + 299 }))))).toBe("ok");
    expect(reasonOf(verify(pair.mint(goodClaims(NOW, { iat: NOW_SEC + 299 }))))).toBe("ok");
  });

  const cases: [string, string | null | undefined, string][] = [
    // no_key
    ["missing", undefined, "no_key"],
    ["null", null, "no_key"],
    ["empty", "", "no_key"],
    ["whitespace", "  \n\t ", "no_key"],
    // malformed: the outer shape
    ["wrong prefix", `ygxl_${h}.${p}.${s}`, "malformed"],
    ["upper case prefix", `YGEL_${h}.${p}.${s}`, "malformed"],
    ["no prefix", `${h}.${p}.${s}`, "malformed"],
    ["two parts", `ygel_${h}.${p}`, "malformed"],
    ["four parts", `${good}.${s}`, "malformed"],
    ["an empty part", `ygel_${h}..${s}`, "malformed"],
    ["= padding", `${good}==`, "malformed"],
    ["a + character", `ygel_${h}.${p.slice(0, -1)}+.${s}`, "malformed"],
    ["a / character", `ygel_${h}.${p}.${s.slice(0, -1)}/`, "malformed"],
    ["a part whose length mod 4 is 1", `ygel_${lengthMod1(h)}.${p}.${s}`, "malformed"],
    ["stray bits in the last character", `ygel_${h}.${p}.${strayBits(s)}`, "malformed"],
    ["a header of zero bytes", `ygel_${"A".repeat(MAX_LICENCE_KEY_LENGTH)}.${p}.${s}`, "malformed"],
    // malformed: the header
    ["a header that isn't JSON", `ygel_${b64("nope")}.${p}.${s}`, "malformed"],
    ["a header that is a JSON array", `ygel_${b64("[1,2]")}.${p}.${s}`, "malformed"],
    ["a header that isn't UTF-8", `ygel_${b64(Buffer.from([0xff, 0xfe, 0xfd]))}.${p}.${s}`, "malformed"],
    // unsupported_alg
    ["alg none", pair.mint(goodClaims(NOW), { alg: "none" }), "unsupported_alg"],
    ["alg ES256", pair.mint(goodClaims(NOW), { alg: "ES256" }), "unsupported_alg"],
    ["typ JWT", pair.mint(goodClaims(NOW), { typ: "JWT" }), "unsupported_alg"],
    // unknown_key
    ["an unknown kid", pair.mint(goodClaims(NOW), { kid: "not_a_key" }), "unknown_key"],
    ["a kid that isn't text", pair.mint(goodClaims(NOW), { kid: 7 }), "unknown_key"],
    ["signed by a key not in the list", other.mint(goodClaims(NOW)), "unknown_key"],
    // bad_signature
    ["a flipped payload byte", `ygel_${h}.${flipByte(p, 12)}.${s}`, "bad_signature"],
    ["a 63 byte signature", `ygel_${h}.${p}.${b64(Buffer.from(s, "base64url").subarray(0, 63))}`, "bad_signature"],
    ["a 65 byte signature", `ygel_${h}.${p}.${b64(Buffer.concat([Buffer.from(s, "base64url"), Buffer.from([0])]))}`, "bad_signature"],
    ["another key's signature under this kid", other.mint(goodClaims(NOW), { kid: pair.publicJwk.kid }), "bad_signature"],
    ["the signature of another key", `ygel_${h}.${p}.${other.mint(goodClaims(NOW)).split(".")[2]}`, "bad_signature"],
    // malformed: the claims, signed
    ["signed claims that aren't JSON", pair.mint({}, {}, { payload: b64("not json") }), "malformed"],
    ["signed claims that are an array", pair.mint({}, {}, { payload: b64("[]") }), "malformed"],
    // wrong_version
    ["v 2", pair.mint(goodClaims(NOW, { v: 2 })), "wrong_version"],
    ["v as text", pair.mint(goodClaims(NOW, { v: "1" })), "wrong_version"],
    ["no v", pair.mint({ ...goodClaims(NOW), v: undefined }), "wrong_version"],
    // bad_claims
    ["seats 0", pair.mint(goodClaims(NOW, { seats: 0 })), "bad_claims"],
    ["seats 1.5", pair.mint(goodClaims(NOW, { seats: 1.5 })), "bad_claims"],
    ["seats over a million", pair.mint(goodClaims(NOW, { seats: 1_000_001 })), "bad_claims"],
    ["seats as text", pair.mint(goodClaims(NOW, { seats: "25" })), "bad_claims"],
    ["features not an array", pair.mint(goodClaims(NOW, { features: "sso" })), "bad_claims"],
    ["65 features", pair.mint(goodClaims(NOW, { features: Array.from({ length: 65 }, (_, i) => `f${i}`) })), "bad_claims"],
    ["a feature that isn't text", pair.mint(goodClaims(NOW, { features: ["sso", 1] })), "bad_claims"],
    ["a 65 character feature", pair.mint(goodClaims(NOW, { features: ["x".repeat(65)] })), "bad_claims"],
    ["an empty licensee", pair.mint(goodClaims(NOW, { licensee: "" })), "bad_claims"],
    ["a 201 character licensee", pair.mint(goodClaims(NOW, { licensee: "x".repeat(201) })), "bad_claims"],
    ["no lid", pair.mint({ ...goodClaims(NOW), lid: undefined }), "bad_claims"],
    ["a 101 character lid", pair.mint(goodClaims(NOW, { lid: "x".repeat(101) })), "bad_claims"],
    ["iat as text", pair.mint(goodClaims(NOW, { iat: "yesterday" })), "bad_claims"],
    ["exp equal to iat", pair.mint(goodClaims(NOW, { exp: NOW_SEC - 3600 })), "bad_claims"],
    ["exp before iat", pair.mint(goodClaims(NOW, { exp: NOW_SEC - 7200 })), "bad_claims"],
    ["nbf as text", pair.mint(goodClaims(NOW, { nbf: "soon" })), "bad_claims"],
    ["nbf null", pair.mint(goodClaims(NOW, { nbf: null })), "bad_claims"],
    // not_yet_valid
    ["nbf beyond the leeway", pair.mint(goodClaims(NOW, { nbf: NOW_SEC + 301 })), "not_yet_valid"],
    ["iat beyond the leeway", pair.mint(goodClaims(NOW, { iat: NOW_SEC + 600 })), "not_yet_valid"],
    // expired
    ["exp in the past", pair.mint(goodClaims(NOW, { iat: NOW_SEC - 7200, exp: NOW_SEC - 1 })), "expired"],
    ["exp right now", pair.mint(goodClaims(NOW, { iat: NOW_SEC - 7200, exp: NOW_SEC })), "expired"],
  ];

  it.each(cases.map(([label, key, reason]) => [label, reason, key] as const))("%s gives %s", (_label, reason, key) => {
    expect(reasonOf(verify(key))).toBe(reason);
  });

  it("refuses a correctly signed key over 4096 characters, and accepts one at or under it", () => {
    // Long features make the key grow in steps of about 90 characters, with valid claims.
    const keyWith = (n: number) => pair.mint(goodClaims(NOW, { features: Array.from({ length: n }, (_, i) => `f${i}`.padEnd(64, "x")) }));
    let n = 1;
    while (keyWith(n + 1).length <= MAX_LICENCE_KEY_LENGTH) n++;
    const under = keyWith(n);
    const over = keyWith(n + 1);
    expect(under.length).toBeLessThanOrEqual(MAX_LICENCE_KEY_LENGTH);
    expect(over.length).toBeGreaterThan(MAX_LICENCE_KEY_LENGTH);
    expect(n + 1).toBeLessThanOrEqual(64);
    expect(reasonOf(verify(under))).toBe("ok");
    expect(reasonOf(verify(over))).toBe("malformed");
  });

  it("keeps the claims of an expired licence, so a screen can say when it ended", () => {
    const claims = goodClaims(NOW, { iat: NOW_SEC - 7200, exp: NOW_SEC - 60 });
    expect(verify(pair.mint(claims))).toEqual({ ok: false, reason: "expired", claims });
  });

  it("fails closed when the time isn't a number", () => {
    expect(reasonOf(verify(good, Number.NaN))).not.toBe("ok");
  });

  it("never throws, whatever it is given", () => {
    const junk: unknown[] = [42, {}, [], "ygel_", "ygel_..", "ygel_a.b.c", "\u0000", "ygel_" + "é".repeat(10)];
    for (const key of junk) {
      expect(() => verifyLicenceKey({ key: key as string, keys: KEYS, nowMs: NOW })).not.toThrow();
    }
  });

  it("picks the public key by kid, so an old key works while a new one is added", () => {
    const next = makeLicenceKeyPair();
    const both = [pair.publicJwk, next.publicJwk];
    expect(reasonOf(verifyLicenceKey({ key: good, keys: both, nowMs: NOW }))).toBe("ok");
    expect(reasonOf(verifyLicenceKey({ key: next.mint(goodClaims(NOW)), keys: both, nowMs: NOW }))).toBe("ok");
    // Once the old key is taken out, keys it signed stop working.
    expect(reasonOf(verifyLicenceKey({ key: good, keys: [next.publicJwk], nowMs: NOW }))).toBe("unknown_key");
  });

  it("verifies nothing against the shipped list unless the key is in it", () => {
    const r = verifyLicenceKey({ key: good, nowMs: NOW });
    expect(reasonOf(r)).toBe(LICENCE_PUBLIC_KEYS.some((k) => k.kid === pair.publicJwk.kid) ? "ok" : "unknown_key");
  });

  it("never logs the key", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    for (const [, key] of cases) verify(key);
    verify(good);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("okpThumbprint", () => {
  it("matches RFC 8037 appendix A.3", () => {
    const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    expect(okpThumbprint({ kty: "OKP", crv: "Ed25519", x })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("matches a JWK export of the generated key", () => {
    const jwk = createPublicKey(pair.privateKey).export({ format: "jwk" });
    expect(jwk.kty).toBe("OKP");
    expect(okpThumbprint({ kty: jwk.kty!, crv: jwk.crv!, x: jwk.x! })).toBe(pair.publicJwk.kid);
  });
});

describe("LICENCE_PUBLIC_KEYS", () => {
  // Passes while the list is empty, and keeps checking each key the owner adds.
  it("holds only Ed25519 keys whose kid is their thumbprint", () => {
    for (const key of LICENCE_PUBLIC_KEYS) {
      expect(Object.keys(key).sort()).toEqual(["crv", "kid", "kty", "x"]);
      expect(key.kty).toBe("OKP");
      expect(key.crv).toBe("Ed25519");
      const x = Buffer.from(key.x, "base64url");
      expect(x).toHaveLength(32);
      expect(x.toString("base64url")).toBe(key.x);
      expect(key.kid).toBe(okpThumbprint(key));
      expect(createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }).asymmetricKeyType).toBe("ed25519");
    }
    const kids = LICENCE_PUBLIC_KEYS.map((k) => k.kid);
    expect(new Set(kids).size).toBe(kids.length);
  });
});

describe("the licence key setting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when unset or empty", () => {
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", undefined);
    expect(licenceKeySetting()).toBeNull();
    expect(currentLicence(NOW)).toEqual({ ok: false, reason: "no_key" });
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", "   ");
    expect(licenceKeySetting()).toBeNull();
  });

  it("is trimmed", () => {
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", `  ${good} \n`);
    expect(licenceKeySetting()).toBe(good);
  });

  it("gives malformed for garbage, never a throw", () => {
    for (const garbage of ["true", "yes please", "ygel_", "ygel_a.b", "{\"alg\":\"none\"}", "x".repeat(10_000)]) {
      vi.stubEnv("ENTERPRISE_LICENCE_KEY", garbage);
      expect(() => currentLicence(NOW)).not.toThrow();
      expect(currentLicence(NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("checks the times on every call, and a new key on change", () => {
    const claims = goodClaims(NOW, { exp: NOW_SEC + 60 });
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", pair.mint(claims));
    expect(currentLicence(NOW, KEYS)).toEqual({ ok: true, claims });
    expect(currentLicence(NOW + 61_000, KEYS)).toEqual({ ok: false, reason: "expired", claims });
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", other.mint(goodClaims(NOW)));
    expect(reasonOf(currentLicence(NOW, KEYS))).toBe("unknown_key");
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", good);
    expect(reasonOf(currentLicence(NOW, KEYS))).toBe("ok");
  });
});
