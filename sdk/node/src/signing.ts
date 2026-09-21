import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing for the YouGrow product-connection protocol.
 *
 *   X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, `${direction}:${timestamp}.${rawBody}`)>
 *
 * `direction` is "events" (your product → YouGrow), "context" or "webhook"
 * (YouGrow → your product). Timestamps are unix seconds; requests more than
 * five minutes off are refused. Pinned by test/vectors.json.
 */

export type Direction = "events" | "context" | "webhook";

export const HEADERS = {
  keyId: "x-yougrow-key-id",
  timestamp: "x-yougrow-timestamp",
  signature: "x-yougrow-signature",
} as const;

export const TOLERANCE_SEC = 300;

export function sign(secret: string, direction: Direction, timestampSec: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${direction}:${timestampSec}.${rawBody}`).digest("hex");
  return `v1=${mac}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "bad_timestamp" | "stale_timestamp" | "bad_signature" };

/** Constant-time verification against one or more secrets (e.g. mid-rotation). */
export function verify(input: {
  secrets: string[];
  direction: Direction;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowMs?: number;
  toleranceSec?: number;
}): VerifyResult {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing_signature" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(input.timestamp);
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > (input.toleranceSec ?? TOLERANCE_SEC)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const provided = input.signature
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => Buffer.from(s));
  for (const secret of input.secrets) {
    const expected = Buffer.from(sign(secret, input.direction, ts, input.rawBody));
    for (const p of provided) {
      if (p.length === expected.length && timingSafeEqual(p, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
