import { tokenFromAuthorization, tokenKid, verifyJwt, type Jwk, type JwtFailure, type RequestDirection, type YouGrowClaims } from "./jwt.js";
import { DEFAULT_ORIGIN, isSecureOrigin, originOf } from "./origin.js";

/**
 * Helpers for the two endpoints YouGrow calls on YOUR server:
 *
 *  - the context endpoint (direction "context"): before an email, YouGrow asks
 *    for one user's onboarding steps, facts and insight sentences;
 *  - the webhook endpoint (direction "webhook"): YouGrow tells you about
 *    preference changes, e.g. an unsubscribe.
 *
 * Every such request carries `Authorization: Bearer <JWT>` signed with
 * YouGrow's private key. Your secret is NOT involved — you verify against
 * YouGrow's public keys, so nothing you store can be used to forge YouGrow.
 * Always verify against the RAW body (the exact bytes received, as a Buffer or
 * string), before parsing it.
 *
 *   const verifier = createVerifier({ keyId: process.env.YOUGROW_KEY_ID!, origin: process.env.YOUGROW_ORIGIN });
 *   const v = await verifier.verify({ headers: req.headers, rawBody, direction: "context" });
 *   if (!v.ok) return res.status(401).end();
 */

export type { Jwk, RequestDirection, YouGrowClaims } from "./jwt.js";

/** YouGrow's default origin: the `iss` of its tokens. */
export const DEFAULT_ISSUER = DEFAULT_ORIGIN;
const JWKS_PATH = "/.well-known/jwks.json";
const MIN_CACHE_MS = 60_000;
const MAX_CACHE_MS = 24 * 3600_000;
const DEFAULT_CACHE_MS = 3600_000;
/** An unknown kid refetches the keys at most this often. */
const REFETCH_COOLDOWN_MS = 60_000;

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const bag = h as Record<string, string | string[] | undefined>;
  let v = bag[name] ?? bag[name.toLowerCase()];
  if (v === undefined) {
    // Plain objects can keep the sender's casing (e.g. API Gateway REST events): match any case.
    const lower = name.toLowerCase();
    v = Object.entries(bag).find(([k, value]) => value !== undefined && k.toLowerCase() === lower)?.[1];
  }
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export type VerifyResult =
  | { ok: true; claims: YouGrowClaims }
  | { ok: false; reason: JwtFailure | "keys_unavailable" };

export interface VerifierOptions {
  /** Your connection's key id — the token's audience. */
  keyId: string;
  /**
   * YouGrow's origin: the same value as the client's `origin`, e.g. from
   * YOUGROW_ORIGIN. Defaults to https://yougrow.ai. Tokens must carry it as
   * `iss`, and the keys are fetched from `${origin}/.well-known/jwks.json`.
   */
  origin?: string;
  /** Alias of `origin` (its 0.1 name). */
  issuer?: string;
  /** Pin the key set instead of fetching it (tests, air-gapped setups). */
  jwks?: { keys: Jwk[] };
  fetch?: typeof fetch;
}

export interface Verifier {
  /**
   * Check one request. `rawBody` is the exact body received — a string, or the
   * bytes (e.g. a Buffer) — never re-serialised JSON. Plain header objects
   * match in any case; Fetch `Headers` already do.
   */
  verify(input: { headers: HeaderBag; rawBody: string | Uint8Array; direction: RequestDirection; nowMs?: number }): Promise<VerifyResult>;
}

function cacheMs(cacheControl: string | null): number {
  const m = /max-age=(\d+)/.exec(cacheControl ?? "");
  const ms = m ? Number(m[1]) * 1000 : DEFAULT_CACHE_MS;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, ms));
}

/**
 * A verifier for one connection. It fetches YouGrow's public keys once, caches
 * them as long as their Cache-Control allows, and refetches early (rate-limited)
 * when a token names a key it hasn't seen — so YouGrow's key rotations need no
 * change on your side. If a refresh fails it keeps using the keys it has.
 */
export function createVerifier(opts: VerifierOptions): Verifier {
  if (opts.origin && opts.issuer && originOf(opts.origin) !== originOf(opts.issuer)) {
    throw new Error("createVerifier: origin and issuer differ (issuer is an alias of origin); pass origin only");
  }
  const issuer = originOf(opts.origin || opts.issuer);
  if (!opts.jwks && !isSecureOrigin(issuer)) throw new Error("createVerifier: origin must be https");
  if (!opts.keyId) throw new Error("createVerifier: keyId is required");
  const doFetch = opts.fetch ?? globalThis.fetch;
  let keys: Jwk[] | null = opts.jwks?.keys ?? null;
  let expiresAt = opts.jwks ? Number.POSITIVE_INFINITY : 0;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function refresh(now: number): Promise<void> {
    if (opts.jwks) return;
    inflight ??= (async () => {
      lastFetchAt = now;
      try {
        const res = await doFetch(`${issuer}${JWKS_PATH}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
        if (!res.ok) return;
        const body = (await res.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) return;
        keys = body.keys as Jwk[];
        expiresAt = Date.now() + cacheMs(res.headers.get("cache-control"));
      } catch {
        // Keep the keys we have (if any); the next request tries again.
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  }

  return {
    async verify(input) {
      if (typeof input.rawBody !== "string" && !ArrayBuffer.isView(input.rawBody)) {
        throw new TypeError("verify: rawBody must be the raw request body (a string or Buffer), not parsed JSON");
      }
      const token = tokenFromAuthorization(header(input.headers, "authorization"));
      const now = Date.now();
      const sinceFetch = now - lastFetchAt;
      if (token && (keys ? now >= expiresAt && sinceFetch >= REFETCH_COOLDOWN_MS : sinceFetch >= 5000)) {
        await refresh(now);
      }
      const kid = token ? tokenKid(token) : null;
      if (token && kid && keys && !keys.some((k) => k.kid === kid) && Date.now() - lastFetchAt >= REFETCH_COOLDOWN_MS) {
        await refresh(now);
      }
      if (token && !keys) return { ok: false, reason: "keys_unavailable" };
      return verifyJwt({
        token,
        keys: keys ?? [],
        issuer,
        audience: opts.keyId,
        direction: input.direction,
        rawBody: input.rawBody,
        nowMs: input.nowMs,
      });
    },
  };
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
