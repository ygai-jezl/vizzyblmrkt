import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailEventType } from "@/lib/types/emailEvent";

/**
 * Mandrill webhook plumbing: signature verification + payload parsing. Mandrill
 * authenticates a webhook POST by signing it with HMAC-SHA1 (base64) over the
 * REGISTERED webhook URL concatenated with each POST parameter's key+value in
 * alphabetical key order. In practice the only POST param is `mandrill_events`,
 * so the signed string is `url + "mandrill_events" + <decoded value>`. The
 * signature arrives in the `X-Mandrill-Signature` header.
 *
 * Why the URL must come from config (not the request): App Hosting sits behind a
 * proxy, so the inbound Host header can differ from the public URL Mandrill
 * signed with. Build the signed URL from MANDRILL_WEBHOOK_URL so it always
 * matches what was registered.
 */

/** Reconstruct the exact string Mandrill signed. Exported for testing. */
export function mandrillSignedData(url: string, rawBody: string): string {
  const params = new URLSearchParams(rawBody);
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) data += k + (params.get(k) ?? "");
  return data;
}

export function verifyMandrillSignature(
  url: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
  key: string,
): boolean {
  if (!signatureHeader || !key) return false;
  const expected = createHmac("sha1", key)
    .update(mandrillSignedData(url, rawBody), "utf8")
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface MandrillEvent {
  event: string;
  ts?: number;
  url?: string;
  msg?: {
    _id?: string;
    email?: string;
    metadata?: Record<string, unknown>;
    [k: string]: unknown;
  };
}

/** Parse the batched `mandrill_events` array out of a form-encoded body. */
export function parseMandrillEvents(rawBody: string): MandrillEvent[] {
  const raw = new URLSearchParams(rawBody).get("mandrill_events");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MandrillEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * Map a Mandrill event name to our EmailEventType, or null for events we don't
 * record (e.g. "deferral", "delayed"). Mandrill emits opens/clicks under the
 * "sync" message-event names below.
 */
export function mapMandrillEventType(event: string): EmailEventType | null {
  switch (event) {
    case "send":
      return "send";
    case "open":
      return "open";
    case "click":
      return "click";
    case "hard_bounce":
      return "bounce";
    case "soft_bounce":
      return "soft_bounce";
    case "spam":
      return "spam";
    case "reject":
      return "reject";
    case "unsub":
      return "unsub";
    default:
      return null;
  }
}

/** Read the journey-send metadata we stamped on the message, or null if absent. */
export interface EventMetadata {
  tenantId: string;
  campaignId: string;
  journeyId: string;
  nodeId: string;
  signupId: string;
  variantId: string;
}

export function readEventMetadata(ev: MandrillEvent): EventMetadata | null {
  const m = ev.msg?.metadata;
  if (!m) return null;
  const get = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : "");
  const meta: EventMetadata = {
    tenantId: get("tenantId"),
    campaignId: get("campaignId"),
    journeyId: get("journeyId"),
    nodeId: get("nodeId"),
    signupId: get("signupId"),
    variantId: get("variantId") || "control",
  };
  // A non-journey send (or a malformed payload) lacks our keys — skip it.
  if (!meta.tenantId || !meta.journeyId || !meta.nodeId || !meta.signupId) {
    return null;
  }
  return meta;
}
