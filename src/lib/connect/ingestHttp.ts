import {
  forTenant,
  getConnectionKey,
  isRateLimited,
  type ConnectionKeyRecord,
  type RateLimitConfig,
  type TenantContext,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { isLifecycleIngestEnabled } from "@/lib/lifecycle/flags";
import { connectionSecrets } from "./keys";
import { ingestBatch } from "./ingest";
import {
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  IngestBodySchema,
  LIMITS,
  verifySignature,
  zodReason,
} from "./protocol";

/**
 * POST /api/v1/events — the product ingest API. Server-to-server only (no CORS):
 * the caller signs the raw body with its connection secret. Order matters:
 *
 *  1. size-capped raw read (the signature covers the exact bytes);
 *  2. key id → tenant + region + connection (control plane, short cache);
 *  3. signature verified against the connection's current/previous secret;
 *  4. THEN the per-key rate limit — forged requests never burn a real key's quota;
 *  5. parse + ingest (per-message validation, idempotent by messageId).
 *
 * The tenant scope comes ONLY from the key record, never the body.
 */

export interface IngestHttpDeps {
  /** Backs both the control plane and the regional DB (tests). */
  db?: FirestoreLike;
  nowMs?: () => number;
  /** Override the durable rate limiter (tests). */
  rateLimit?: (keyId: string) => Promise<boolean>;
}

/** Per key: 120 requests/minute, 3,000/hour (up to 100 messages each). */
export const INGEST_RATE_LIMIT: RateLimitConfig = {
  prefix: "ingest",
  burstLimit: 120,
  hourlyLimit: 3000,
};

const KEY_CACHE_MS = 60_000;
const UNKNOWN_KEY_CACHE_MS = 10_000;
const CONNECTION_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

const keyCache = new Map<string, { rec: ConnectionKeyRecord | null; until: number }>();
const connectionCache = new Map<string, { conn: ProductConnection | null; until: number }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Drop cached routing/connection state (call after a revoke or rotation). */
export function invalidateConnectionCaches(keyId: string, tenantId: string, connectionId: string): void {
  keyCache.delete(keyId);
  connectionCache.delete(`${tenantId}/${connectionId}`);
}

/** Test helper. */
export function __resetIngestCaches(): void {
  keyCache.clear();
  connectionCache.clear();
}

async function resolveKey(keyId: string, nowMs: number, db?: FirestoreLike) {
  const hit = keyCache.get(keyId);
  if (hit && hit.until > nowMs) return hit.rec;
  const rec = await getConnectionKey(keyId, db);
  remember(keyCache, keyId, { rec, until: nowMs + (rec ? KEY_CACHE_MS : UNKNOWN_KEY_CACHE_MS) });
  return rec;
}

async function loadConnection(ctx: TenantContext, id: string, nowMs: number, db?: FirestoreLike) {
  const cacheKey = `${ctx.tenantId}/${id}`;
  const hit = connectionCache.get(cacheKey);
  if (hit && hit.until > nowMs) return hit.conn;
  const conn = await forTenant(ctx, db).productConnections.getById(id);
  remember(connectionCache, cacheKey, { conn, until: nowMs + CONNECTION_CACHE_MS });
  return conn;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export async function handleIngestRequest(req: Request, deps: IngestHttpDeps = {}): Promise<Response> {
  if (!isLifecycleIngestEnabled()) return json(503, { error: "ingest_disabled" });
  const nowMs = (deps.nowMs ?? Date.now)();

  const raw = await readRequestTextCapped(req, LIMITS.maxBodyBytes);
  if (raw === null) return json(413, { error: "body_too_large", maxBytes: LIMITS.maxBodyBytes });

  const keyId = req.headers.get(HEADER_KEY_ID)?.trim() ?? "";
  if (!keyId) return json(401, { error: "missing_signature" });

  let rec: ConnectionKeyRecord | null;
  let connection: ProductConnection | null = null;
  let ctx: TenantContext | null = null;
  try {
    rec = await resolveKey(keyId, nowMs, deps.db);
    if (rec) {
      ctx = { tenantId: rec.tenantId, region: rec.region, source: "api_key" };
      connection = await loadConnection(ctx, rec.connectionId, nowMs, deps.db);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.error(`[connect] key resolution failed: ${m}`);
    return json(503, { error: "unavailable" });
  }
  if (!ctx || !connection || connection.status === "revoked" || connection.keyId !== keyId) {
    return json(401, { error: "unknown_key" });
  }

  let secrets: string[];
  try {
    secrets = connectionSecrets(connection, nowMs);
  } catch {
    return json(503, { error: "connect_unconfigured" });
  }
  const verified = verifySignature({
    secrets,
    direction: "events",
    timestamp: req.headers.get(HEADER_TIMESTAMP),
    signature: req.headers.get(HEADER_SIGNATURE),
    rawBody: raw,
    nowMs,
  });
  if (!verified.ok) return json(401, { error: verified.reason });

  const limiter =
    deps.rateLimit ?? ((k: string) => isRateLimited(k, INGEST_RATE_LIMIT, { db: deps.db, now: nowMs }));
  if (await limiter(keyId)) return json(429, { error: "rate_limited" }, { "retry-after": "60" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = IngestBodySchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_batch", detail: zodReason(parsed.error) });
  if (parsed.data.batch.length > LIMITS.maxBatch) {
    return json(413, { error: "batch_too_large", maxBatch: LIMITS.maxBatch });
  }

  try {
    const summary = await ingestBatch(ctx, connection, parsed.data.batch, { db: deps.db, nowMs });
    return json(202, summary);
  } catch (err) {
    // Safe for the product to retry: every message is idempotent by messageId.
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.error(`[connect] ingest failed for ${ctx.tenantId}/${connection.id}: ${m}`);
    return json(500, { error: "internal" });
  }
}
