import { describe, it, expect } from "vitest";
import vectorsFile from "./vectors.json";
import { sign, type Direction } from "../src/signing.js";
import { verifyJwt, type Jwk, type RequestDirection } from "../src/jwt.js";

const vectors = vectorsFile.vectors as Array<{
  secret: string;
  direction: Direction;
  timestamp: number;
  body: string;
  signature: string;
}>;

const out = vectorsFile.outbound as {
  issuer: string;
  audience: string;
  nowMs: number;
  jwks: { keys: Jwk[] };
  tokens: { direction: RequestDirection; body: string; token: string }[];
};

describe("SDK event signing matches the shared vectors", () => {
  it.each(vectors.map((v, i) => [i, v] as const))("vector %i", (_i, v) => {
    expect(sign(v.secret, v.direction, v.timestamp, v.body)).toBe(v.signature);
  });
});

describe("SDK verifies YouGrow's tokens from the shared vectors", () => {
  const base = (t: (typeof out.tokens)[number]) => ({
    token: t.token,
    keys: out.jwks.keys,
    issuer: out.issuer,
    audience: out.audience,
    direction: t.direction,
    rawBody: t.body,
    nowMs: out.nowMs,
  });

  it.each(out.tokens.map((t) => [t.direction, t] as const))("accepts the %s vector", (_d, t) => {
    expect(verifyJwt(base(t)).ok).toBe(true);
  });

  it("rejects tampering, the wrong audience or direction, and old tokens", () => {
    const t = out.tokens[0]!;
    const reason = (r: ReturnType<typeof verifyJwt>) => (r.ok ? "ok" : r.reason);
    expect(reason(verifyJwt({ ...base(t), rawBody: `${t.body} ` }))).toBe("body_mismatch");
    expect(reason(verifyJwt({ ...base(t), audience: "ygk_other" }))).toBe("wrong_audience");
    expect(reason(verifyJwt({ ...base(t), direction: "webhook" }))).toBe("wrong_direction");
    expect(reason(verifyJwt({ ...base(t), issuer: "https://evil.example" }))).toBe("wrong_issuer");
    expect(reason(verifyJwt({ ...base(t), nowMs: out.nowMs + 3600_000 }))).toBe("expired");
    expect(reason(verifyJwt({ ...base(t), keys: [] }))).toBe("unknown_key");
    const [, p, s] = t.token.split(".");
    const none = Buffer.from(JSON.stringify({ alg: "none", kid: out.jwks.keys[0]!.kid })).toString("base64url");
    expect(reason(verifyJwt({ ...base(t), token: `${none}.${p}.${s}` }))).toBe("unsupported_alg");
  });
});
