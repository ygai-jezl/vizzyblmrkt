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

/**
 * Map a publishToX result to a worker outcome. Because X has NO idempotency key:
 *  - a PARTIALLY-posted thread or an ambiguous 2xx → PARK with posted=true (a retry
 *    OR a re-arm would duplicate the live tweet);
 *  - a permanent, nothing-posted condition (empty copy / not connected) → PARK with
 *    posted=false (unfixable by retry, but safe to re-arm after the operator fixes it);
 *  - a clean transient failure (first-tweet error, network drop) → RETRY.
 */
export function classifyXResult(result: XPublishResult): XOutcome {
  if (result.ok) return { kind: "published", remoteId: result.remoteId, url: result.url };
  if (result.reason === "empty" || result.reason === "not_connected") {
    return { kind: "park", reason: result.reason, posted: false };
  }
  if (result.reason.includes("partial") || result.reason.startsWith("created_unconfirmed")) {
    return { kind: "park", reason: result.reason, posted: true };
  }
  return { kind: "retry", reason: result.reason };
}
