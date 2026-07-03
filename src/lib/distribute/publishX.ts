import { splitIntoTweets } from "./preview/x";
import type { XPublishResult } from "@/lib/social/x/client";

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

export type XOutcome =
  | { kind: "published"; remoteId: string; url: string }
  | { kind: "retry"; reason: string }
  /** `posted` = a tweet MAY already be live → the caller must block a re-arm/re-publish. */
  | { kind: "park"; reason: string; posted: boolean };

/** Permanent, nothing-posted failures — retrying can't fix them, so park on the
 *  first occurrence. 401/402/403 are token-scope / access-tier refusals from X
 *  (the tweet never posted); empty/not_connected are bad local input/state. */
const PERMANENT_CODES = new Set(["empty", "not_connected", "x_api_401", "x_api_402", "x_api_403"]);

/**
 * Map a publishToX result to a worker outcome. Because X has NO idempotency key:
 *  - a PARTIALLY-posted thread or an ambiguous 2xx → PARK with posted=true (a retry
 *    OR a re-arm would duplicate the live tweet);
 *  - a permanent, nothing-posted condition (empty / not_connected / auth-tier 4xx) →
 *    PARK with posted=false (unfixable by retry, but safe to re-arm after a fix);
 *  - a transient failure (network drop, 429 rate-limit, 5xx before any post) → RETRY.
 * The reason may carry a human ":detail" suffix (X's error message) — classify off the
 * leading machine code only so that free text can't flip the decision.
 */
export function classifyXResult(result: XPublishResult): XOutcome {
  if (result.ok) return { kind: "published", remoteId: result.remoteId, url: result.url };
  const code = result.reason.split(":")[0] ?? result.reason;
  if (code.endsWith("_partial") || code.startsWith("created_unconfirmed")) {
    return { kind: "park", reason: result.reason, posted: true };
  }
  if (PERMANENT_CODES.has(code)) {
    return { kind: "park", reason: result.reason, posted: false };
  }
  return { kind: "retry", reason: result.reason };
}
