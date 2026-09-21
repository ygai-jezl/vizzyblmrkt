import { createHash } from "node:crypto";
import { getDb } from "./firestore";
import type { FirestoreLike } from "./types";

/**
 * Durable, cross-instance rate limiter for machine-facing endpoints (the product
 * ingest API keyed by connection key id; public routes keyed by client IP).
 * Ported from vizzybl.ai's src/lib/rateLimit/firestoreRateLimit.ts:
 *
 * - An in-memory fast path per instance (cheap, rejects obvious floods), then a
 *   Firestore TRANSACTION as the authoritative count shared by every instance.
 * - A circuit breaker: under a flood of rejections, Firestore checks pause for a
 *   cooldown and only the in-memory limiter applies, so a DDoS can't turn into a
 *   Firestore billing spike.
 * - Fails OPEN on a Firestore error (the in-memory limiter already allowed it):
 *   an outage of the limiter store must not take the endpoint down.
 *
 * Counters live in the control-plane `rate_limits` collection, keyed by a hash of
 * `prefix:subject` (no raw key ids or IPs at rest). The `ttl` Date field is for a
 * Firestore TTL policy (set up by infra/lifecycle/setup.sh) that deletes stale
 * counters.
 */

export interface RateLimitConfig {
  /** Route/purpose identifier; limits with different prefixes are independent. */
  prefix: string;
  /** Max requests per rolling one-minute window. */
  burstLimit: number;
  /** Max requests per one-hour window. */
  hourlyLimit: number;
}

const BURST_WINDOW_MS = 60_000;
const HOURLY_WINDOW_MS = 3_600_000;
const TTL_MS = 2 * HOURLY_WINDOW_MS;
const COLLECTION = "rate_limits";

// ---- In-memory fast path ----------------------------------------------------

interface Window {
  burstCount: number;
  burstStart: number;
  hourlyCount: number;
  hourlyStart: number;
}

const memWindows = new Map<string, Window>();
const MEM_MAX_KEYS = 10_000;

/** Advance a window to `now` and, unless over a limit, count this request. */
function consume(w: Window, config: RateLimitConfig, now: number): boolean {
  if (now - w.burstStart >= BURST_WINDOW_MS) {
    w.burstCount = 0;
    w.burstStart = now;
  }
  if (now - w.hourlyStart >= HOURLY_WINDOW_MS) {
    w.hourlyCount = 0;
    w.hourlyStart = now;
  }
  if (w.burstCount >= config.burstLimit || w.hourlyCount >= config.hourlyLimit) {
    return false;
  }
  w.burstCount += 1;
  w.hourlyCount += 1;
  return true;
}

function checkMemory(key: string, config: RateLimitConfig, now: number): boolean {
  let w = memWindows.get(key);
  if (!w) {
    if (memWindows.size >= MEM_MAX_KEYS) {
      // Bound memory: evict the oldest-inserted key.
      const oldest = memWindows.keys().next().value;
      if (oldest) memWindows.delete(oldest);
    }
    w = { burstCount: 0, burstStart: now, hourlyCount: 0, hourlyStart: now };
    memWindows.set(key, w);
  }
  return consume(w, config, now);
}

// ---- Circuit breaker --------------------------------------------------------

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 500; // rejections per minute before opening
const CIRCUIT_COOLDOWN_MS = 120_000;

let rejections = 0;
let rejectionsWindowStart = 0;
let circuitOpenedAt: number | null = null;

function recordRejection(now: number): void {
  if (now - rejectionsWindowStart >= CIRCUIT_WINDOW_MS) {
    rejections = 0;
    rejectionsWindowStart = now;
  }
  rejections += 1;
  if (circuitOpenedAt === null && rejections >= CIRCUIT_THRESHOLD) {
    circuitOpenedAt = now;
    console.warn("[rateLimit] circuit breaker OPEN — Firestore checks paused");
  }
}

function isCircuitOpen(now: number): boolean {
  if (circuitOpenedAt === null) return false;
  if (now - circuitOpenedAt >= CIRCUIT_COOLDOWN_MS) {
    circuitOpenedAt = null;
    rejections = 0;
    rejectionsWindowStart = now;
    console.warn("[rateLimit] circuit breaker CLOSED — Firestore checks resumed");
    return false;
  }
  return true;
}

/** Test helper: reset all per-instance state. */
export function __resetRateLimitState(): void {
  memWindows.clear();
  rejections = 0;
  rejectionsWindowStart = 0;
  circuitOpenedAt = null;
}

// ---- Firestore authoritative check ------------------------------------------

function counterId(subject: string, prefix: string): string {
  return createHash("sha256").update(`${prefix}:${subject}`).digest("hex").slice(0, 32);
}

/** True when the shared counter says the request is over a limit. */
async function checkFirestore(
  db: FirestoreLike,
  id: string,
  config: RateLimitConfig,
  now: number,
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = (snap.exists ? snap.data() : null) ?? {};
    const w: Window = {
      burstCount: typeof data.burstCount === "number" ? data.burstCount : 0,
      burstStart: typeof data.burstStart === "number" ? data.burstStart : now,
      hourlyCount: typeof data.hourlyCount === "number" ? data.hourlyCount : 0,
      hourlyStart: typeof data.hourlyStart === "number" ? data.hourlyStart : now,
    };
    if (!consume(w, config, now)) return true;
    txn.set(ref, { ...w, prefix: config.prefix, ttl: new Date(now + TTL_MS) });
    return false;
  });
}

// ---- Public API -------------------------------------------------------------

/**
 * Whether a request from `subject` (a connection key id, a client IP, …) should
 * be REJECTED under `config`. Counts the request when it is allowed.
 */
export async function isRateLimited(
  subject: string,
  config: RateLimitConfig,
  opts: { db?: FirestoreLike; now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const id = counterId(subject, config.prefix);

  if (!checkMemory(id, config, now)) {
    recordRejection(now);
    return true;
  }
  if (isCircuitOpen(now)) return false; // flood in progress: in-memory only

  try {
    const db = opts.db ?? (getDb() as unknown as FirestoreLike);
    const blocked = await checkFirestore(db, id, config, now);
    if (blocked) recordRejection(now);
    return blocked;
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.error(`[rateLimit] Firestore check failed; using the in-memory result: ${msg}`);
    return false;
  }
}
