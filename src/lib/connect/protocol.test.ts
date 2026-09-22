import { describe, it, expect } from "vitest";
import vectorsFile from "../../../sdk/node/test/vectors.json";
import {
  ContextResponseSchema,
  IngestMessageSchema,
  signBody,
  signedHeaders,
  verifySignature,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  type SignDirection,
} from "./protocol";

const vectors = vectorsFile.vectors as Array<{
  secret: string;
  direction: SignDirection;
  timestamp: number;
  body: string;
  signature: string;
}>;

describe("signing (shared vectors — the SDK must match these too)", () => {
  it.each(vectors.map((v, i) => [i, v] as const))("reproduces vector %i exactly", (_i, v) => {
    expect(signBody(v.secret, v.direction, v.timestamp, v.body)).toBe(v.signature);
  });

  it("verifies every vector inside the skew window", () => {
    for (const v of vectors) {
      expect(
        verifySignature({
          secrets: [v.secret],
          direction: v.direction,
          timestamp: String(v.timestamp),
          signature: v.signature,
          rawBody: v.body,
          nowMs: v.timestamp * 1000 + 60_000,
        }),
      ).toEqual({ ok: true });
    }
  });
});

describe("verifySignature", () => {
  const secret = "ygs_s3cret";
  const body = '{"batch":[]}';
  const ts = 1_758_455_000;
  const nowMs = ts * 1000;
  const sig = signBody(secret, "events", ts, body);
  const base = { secrets: [secret], direction: "events" as const, timestamp: String(ts), signature: sig, rawBody: body, nowMs };

  it("rejects a tampered body or the wrong secret", () => {
    expect(verifySignature({ ...base, rawBody: '{"batch":[1]}' })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySignature({ ...base, secrets: ["ygs_other"] })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("enforces the ±5 minute window both ways", () => {
    expect(verifySignature({ ...base, nowMs: nowMs + 301_000 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifySignature({ ...base, nowMs: nowMs - 301_000 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifySignature({ ...base, nowMs: nowMs + 299_000 })).toEqual({ ok: true });
  });

  it("reports missing and malformed headers distinctly", () => {
    expect(verifySignature({ ...base, signature: null })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifySignature({ ...base, timestamp: null })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifySignature({ ...base, timestamp: "12.5" })).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verifySignature({ ...base, signature: "sha256=abc" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts either secret during a rotation, and several v1 values", () => {
    const newSig = signBody("ygs_new", "events", ts, body);
    expect(verifySignature({ ...base, secrets: ["ygs_new", secret] })).toEqual({ ok: true });
    expect(verifySignature({ ...base, signature: `v1=deadbeef, ${newSig}`, secrets: ["ygs_new"] })).toEqual({
      ok: true,
    });
  });

  it("round-trips through signedHeaders", () => {
    const h = signedHeaders("ygk_k", secret, "events", body, nowMs);
    expect(h[HEADER_KEY_ID]).toBe("ygk_k");
    expect(
      verifySignature({
        secrets: [secret],
        direction: "events",
        timestamp: h[HEADER_TIMESTAMP]!,
        signature: h[HEADER_SIGNATURE]!,
        rawBody: body,
        nowMs,
      }),
    ).toEqual({ ok: true });
  });
});

describe("message schemas", () => {
  const ok = { messageId: "m1", userId: "u1", timestamp: "2026-09-21T10:00:00Z" };

  it("accepts identify and track, rejecting unzoned timestamps and bad names", () => {
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: { plan: "pro" } }).success).toBe(true);
    expect(IngestMessageSchema.safeParse({ type: "track", ...ok, event: "user.signed_up" }).success).toBe(true);
    expect(IngestMessageSchema.safeParse({ type: "track", ...ok, event: "User Signed Up" }).success).toBe(false);
    expect(
      IngestMessageSchema.safeParse({ type: "identify", ...ok, timestamp: "2026-09-21T10:00:00" }).success,
    ).toBe(false);
    expect(IngestMessageSchema.safeParse({ type: "alias", ...ok }).success).toBe(false);
  });

  it("rejects nested trait values and more than 50 traits", () => {
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: { a: { b: 1 } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${i}`, i]));
    expect(IngestMessageSchema.safeParse({ type: "identify", ...ok, traits: many }).success).toBe(false);
  });

  it("parses a context response and caps its lists", () => {
    const good = ContextResponseSchema.safeParse({
      asOf: "2026-09-21T10:00:00Z",
      steps: [{ id: "create_brand", label: "Create brand", done: true }],
      facts: [{ id: "sov", label: "Share of voice", value: 12.5, unit: "%" }],
      insights: [{ id: "i1", sentence: "ChatGPT named 3 competitors but not you.", factIds: ["sov"] }],
    });
    expect(good.success).toBe(true);
    const tooMany = ContextResponseSchema.safeParse({
      asOf: "2026-09-21T10:00:00Z",
      insights: Array.from({ length: 21 }, (_, i) => ({ id: `i${i}`, sentence: "x" })),
    });
    expect(tooMany.success).toBe(false);
  });
});
