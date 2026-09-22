import { describe, it, expect } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import vectorsFile from "../../../sdk/node/test/vectors.json";
import {
  bearerToken,
  crc32c,
  derToJose,
  verifyOutboundToken,
  type OutboundDirection,
  type PublicJwk,
} from "./outboundToken";

const out = vectorsFile.outbound as {
  issuer: string;
  audience: string;
  nowMs: number;
  jwks: { keys: PublicJwk[] };
  tokens: { direction: OutboundDirection; body: string; token: string }[];
  der: { message: string; der: string; publicJwk: PublicJwk };
};

const base = (t: (typeof out.tokens)[number]) => ({
  token: t.token,
  jwks: out.jwks.keys,
  issuer: out.issuer,
  audience: out.audience,
  direction: t.direction,
  rawBody: t.body,
  nowMs: out.nowMs,
});

describe("outbound tokens (shared vectors — the SDK must match these too)", () => {
  it.each(out.tokens.map((t) => [t.direction, t] as const))("accepts the %s vector", (_d, t) => {
    const r = verifyOutboundToken(base(t));
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims).toMatchObject({ iss: out.issuer, aud: out.audience, dir: t.direction });
  });

  it("rejects every tampering", () => {
    const t = out.tokens[0]!;
    const [h, p, s] = t.token.split(".") as [string, string, string];
    const flip = (x: string) => (x[5] === "A" ? `${x.slice(0, 5)}B${x.slice(6)}` : `${x.slice(0, 5)}A${x.slice(6)}`);
    const reasons = [
      verifyOutboundToken({ ...base(t), rawBody: `${t.body} ` }),
      verifyOutboundToken({ ...base(t), audience: "ygk_someone_else" }),
      verifyOutboundToken({ ...base(t), issuer: "https://evil.example" }),
      verifyOutboundToken({ ...base(t), direction: "webhook" }),
      verifyOutboundToken({ ...base(t), nowMs: out.nowMs + 10 * 60_000 }),
      verifyOutboundToken({ ...base(t), nowMs: out.nowMs - 5 * 60_000 }),
      verifyOutboundToken({ ...base(t), token: `${h}.${flip(p)}.${s}` }),
      verifyOutboundToken({ ...base(t), token: `${h}.${p}.${flip(s)}` }),
      verifyOutboundToken({ ...base(t), jwks: [] }),
      verifyOutboundToken({ ...base(t), token: null }),
      verifyOutboundToken({ ...base(t), token: "a.b" }),
    ].map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons).toEqual([
      "body_mismatch",
      "wrong_audience",
      "wrong_issuer",
      "wrong_direction",
      "expired",
      "not_yet_valid",
      "bad_signature",
      "bad_signature",
      "unknown_key",
      "missing_token",
      "malformed",
    ]);
  });

  it("refuses alg=none and HS256 headers without trying a key", () => {
    const t = out.tokens[0]!;
    const [, p, s] = t.token.split(".") as [string, string, string];
    for (const alg of ["none", "HS256"]) {
      const h = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid: out.jwks.keys[0]!.kid })).toString("base64url");
      expect(verifyOutboundToken({ ...base(t), token: `${h}.${p}.${s}` })).toEqual({ ok: false, reason: "unsupported_alg" });
    }
  });

  it("reads only well-formed bearer headers", () => {
    expect(bearerToken("Bearer aa.bb.cc")).toBe("aa.bb.cc");
    expect(bearerToken("bearer aa.bb.cc")).toBeNull();
    expect(bearerToken("Basic aa.bb.cc")).toBeNull();
    expect(bearerToken("Bearer aa.bb")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("KMS helpers", () => {
  it("converts a DER ECDSA signature (Cloud KMS format) to JOSE r‖s", () => {
    const jose = derToJose(Buffer.from(out.der.der, "base64"));
    expect(jose).toHaveLength(64);
    const { kty, crv, x, y } = out.der.publicJwk;
    const key = createPublicKey({ key: { kty, crv, x, y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(out.der.message), { key, dsaEncoding: "ieee-p1363" }, jose)).toBe(true);
    expect(() => derToJose(Buffer.from("3006020101020101ff", "hex"))).toThrow();
  });

  it("computes CRC32C (Castagnoli) like Cloud KMS", () => {
    expect(crc32c(Buffer.from("123456789"))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });
});
