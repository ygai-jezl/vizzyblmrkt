import { HEADERS, verify, type VerifyResult } from "./signing.js";

/**
 * Helpers for the two endpoints YouGrow calls on YOUR server:
 *
 *  - the context endpoint (direction "context"): before an email, YouGrow asks
 *    for one user's onboarding steps, facts and insight sentences;
 *  - the webhook endpoint (direction "webhook"): YouGrow tells you about
 *    preference changes, e.g. an unsubscribe.
 *
 * Always verify the signature against the RAW body, before parsing it.
 */

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const bag = h as Record<string, string | string[] | undefined>;
  const v = bag[name] ?? bag[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Verify a request YouGrow sent you. Accepts Node or Fetch-style headers. */
export function verifyRequest(input: {
  headers: HeaderBag;
  rawBody: string;
  secret: string | string[];
  direction: "context" | "webhook";
  nowMs?: number;
}): VerifyResult {
  return verify({
    secrets: Array.isArray(input.secret) ? input.secret : [input.secret],
    direction: input.direction,
    timestamp: header(input.headers, HEADERS.timestamp),
    signature: header(input.headers, HEADERS.signature),
    rawBody: input.rawBody,
    nowMs: input.nowMs,
  });
}

export interface ContextStep {
  id: string;
  label: string;
  done: boolean;
  doneAt?: string | null;
  url?: string | null;
  blocked?: string | null;
}

export interface ContextFact {
  id: string;
  label: string;
  value: string | number | boolean;
  unit?: string | null;
  display?: string | null;
  source?: string | null;
  observedAt?: string | null;
}

export interface ContextInsight {
  id: string;
  /** A complete, TRUE sentence — the only place numbers about the user appear. */
  sentence: string;
  factIds?: string[];
  weight?: number;
  supportsStep?: string | null;
}

export interface ContextInput {
  asOf?: Date | string;
  steps?: ContextStep[];
  nextStep?: { id: string; label: string; url?: string | null } | null;
  facts?: ContextFact[];
  insights?: ContextInsight[];
  consent?: { basis: "consent" | "soft_opt_in" | "corporate_subscriber" | "none"; categories?: Record<string, boolean> } | null;
  /** Don't email this user yet (e.g. data still loading). */
  hold?: { until?: string | null; reason: string } | null;
  /** Stop all lifecycle email for this user (e.g. staff, pending deletion). */
  exit?: { reason: string } | null;
}

/**
 * Build a context response body. Throws on values YouGrow would reject, so
 * mistakes show up in your logs rather than as a failed context pull.
 */
export function contextResponse(input: ContextInput): string {
  const steps = input.steps ?? [];
  const facts = input.facts ?? [];
  const insights = input.insights ?? [];
  if (steps.length > 20) throw new Error("contextResponse: at most 20 steps");
  if (facts.length > 50) throw new Error("contextResponse: at most 50 facts");
  if (insights.length > 20) throw new Error("contextResponse: at most 20 insights");
  for (const i of insights) {
    if (i.sentence.length > 300) throw new Error(`contextResponse: insight ${i.id} is over 300 characters`);
  }
  const asOf = input.asOf === undefined ? new Date() : input.asOf;
  const body = JSON.stringify({
    asOf: typeof asOf === "string" ? asOf : asOf.toISOString(),
    steps,
    nextStep: input.nextStep ?? null,
    facts,
    insights,
    ...(input.consent ? { consent: input.consent } : {}),
    ...(input.hold ? { hold: input.hold } : {}),
    ...(input.exit ? { exit: input.exit } : {}),
  });
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new Error("contextResponse: over 64 KB");
  return body;
}
