import { createHmac } from "node:crypto";

/**
 * Request signing for events your product sends to YouGrow:
 *
 *   X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, `events:${timestamp}.${rawBody}`)>
 *
 * Timestamps are unix seconds; requests more than five minutes off are refused.
 * Pinned by test/vectors.json.
 *
 * Requests YouGrow sends YOU (context pulls, webhooks) are not signed with your
 * secret: they carry a JWT signed with YouGrow's own key. Verify those with
 * `createVerifier` from "@yougrow/node/server".
 */

export type Direction = "events";

export const HEADERS = {
  keyId: "x-yougrow-key-id",
  timestamp: "x-yougrow-timestamp",
  signature: "x-yougrow-signature",
} as const;

export function sign(secret: string, direction: Direction, timestampSec: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${direction}:${timestampSec}.${rawBody}`).digest("hex");
  return `v1=${mac}`;
}
