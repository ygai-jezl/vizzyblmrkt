import { splitIntoTweets } from "./preview/x";

/**
 * Worker-side helpers for publishing a scheduled post to X. Pure + testable; the
 * impure bits (token lookup + the publishToX call) live in the scheduler.
 */

/** Real X publishing is enabled (flag OFF by default; requires provisioned creds). */
export function isSocialPublishEnabled(): boolean {
  return process.env.DISTRIBUTE_SOCIAL_ENABLED === "true";
}

/**
 * The ordered tweet parts to publish: an operator-built thread (Phase-2b
 * deconstructor) if present, else the (spintax-rendered) copy split to ≤280.
 */
export function buildXThread(
  threadParts: string[] | null | undefined,
  copy: string,
): string[] {
  if (threadParts && threadParts.length) return threadParts.map((p) => p.trim()).filter(Boolean);
  return splitIntoTweets(copy);
}

export type PublishOutcome =
  | { kind: "published"; remoteId: string; url: string }
  | { kind: "retry"; reason: string }
  /** `posted` = a post MAY already be live → the caller must block a re-arm/re-publish. */
  | { kind: "park"; reason: string; posted: boolean };

/** The structural shape both publishToX and postToLinkedIn return. */
type PublishResult = { ok: true; remoteId: string; url: string } | { ok: false; reason: string };

/**
 * Map a social publish result (X or LinkedIn) to a worker outcome. No platform here
 * has an idempotency key, so:
 *  - a PARTIALLY-posted thread / ambiguous 2xx / wall-time timeout → PARK posted=true
 *    (a retry OR a re-arm would duplicate the live post);
 *  - a permanent, nothing-posted condition (empty / not_connected / a 4xx client error
 *    other than 429) → PARK posted=false (unfixable by retry, safe to re-arm after a fix);
 *  - a transient failure (network drop, 429 rate-limit, 5xx) → RETRY.
 * Classify off the leading machine code (before any ":detail" suffix); works for both
 * the `x_api_NNN` and `li_api_NNN` reason prefixes.
 */
export function classifyPublishResult(result: PublishResult): PublishOutcome {
  if (result.ok) return { kind: "published", remoteId: result.remoteId, url: result.url };
  const code = result.reason.split(":")[0] ?? result.reason;
  if (code.endsWith("_partial") || code.startsWith("created_unconfirmed") || code === "timeout") {
    return { kind: "park", reason: result.reason, posted: true };
  }
  // A 4xx is a permanent client error (retrying won't help) EXCEPT the transient ones:
  // 408 Request Timeout, 425 Too Early, 429 Too Many Requests → those still retry.
  const status = code.match(/_api_(\d{3})$/)?.[1];
  const permanent4xx = status ? status.startsWith("4") && !["408", "425", "429"].includes(status) : false;
  if (code === "empty" || code === "not_connected" || permanent4xx) {
    return { kind: "park", reason: result.reason, posted: false };
  }
  return { kind: "retry", reason: result.reason };
}
