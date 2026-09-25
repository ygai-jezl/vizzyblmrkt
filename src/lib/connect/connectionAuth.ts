import { createHash, timingSafeEqual } from "node:crypto";
import { forTenant, getConnectionKey, type ConnectionKeyRecord, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { connectionSecrets } from "./keys";

/**
 * Who is calling the product API: a key id resolved to its tenant, region and
 * connection (control plane, short caches), and the secret checked against the
 * connection's current — or, for a day after a rotation, previous — secret.
 * The tenant scope comes ONLY from the key record, never from the request.
 */

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
export function __resetConnectionCaches(): void {
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

export type ResolvedConnection = { ctx: TenantContext; connection: ProductConnection };

/**
 * A key id → its live connection, or null when unknown or revoked. Throws when
 * the control plane can't be read (the caller answers 503, not 401).
 */
export async function resolveConnection(keyId: string, nowMs: number, db?: FirestoreLike): Promise<ResolvedConnection | null> {
  const rec = await resolveKey(keyId, nowMs, db);
  if (!rec) return null;
  const ctx: TenantContext = { tenantId: rec.tenantId, region: rec.region, source: "api_key" };
  const connection = await loadConnection(ctx, rec.connectionId, nowMs, db);
  if (!connection || connection.status === "revoked" || connection.keyId !== keyId) return null;
  return { ctx, connection };
}

/** `Authorization: Basic base64(keyId:secret)` → its parts, or null. */
export function parseBasicAuth(header: string | null): { keyId: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  const keyId = decoded.slice(0, colon).trim();
  const secret = decoded.slice(colon + 1);
  return keyId && secret ? { keyId, secret } : null;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of a presented secret against the connection's current (and rotating-out) secrets. */
export function secretMatches(connection: ProductConnection, presented: string, nowMs: number): boolean {
  const given = digest(presented);
  let ok = false;
  for (const secret of connectionSecrets(connection, nowMs)) {
    if (timingSafeEqual(digest(secret), given)) ok = true; // no early exit
  }
  return ok;
}
