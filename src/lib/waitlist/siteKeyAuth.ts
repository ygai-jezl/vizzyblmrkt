import { createHash, timingSafeEqual } from "node:crypto";
import { forTenant, getLaunchKey, type LaunchKeyRecord, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { SiteKey } from "@/lib/types/siteKey";
import { parseBasicAuth } from "@/lib/connect/connectionAuth";
import { siteKeySecrets } from "./siteKeys";

/**
 * Who is calling POST /api/v2/signups: a site key id resolved to its tenant, region
 * and launch (control plane, short caches), and the secret checked against the
 * key's current (or, for a day after a rotation, previous) secret. The tenant and
 * the launch come ONLY from the key record, never from the request. Its own lookup
 * and caches, so a product key never passes here and a site key never passes on
 * the product routes.
 */

const KEY_CACHE_MS = 60_000;
const UNKNOWN_KEY_CACHE_MS = 10_000;
const SITE_KEY_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

const keyCache = new Map<string, { rec: LaunchKeyRecord | null; until: number }>();
const siteKeyCache = new Map<string, { key: SiteKey | null; until: number }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Drop this instance's cached routing and key (call after a revoke or rotation). */
export function invalidateSiteKeyCaches(keyId: string, tenantId: string, campaignId: string): void {
  keyCache.delete(keyId);
  siteKeyCache.delete(`${tenantId}/${campaignId}`);
}

/** Test helper. */
export function __resetSiteKeyCaches(): void {
  keyCache.clear();
  siteKeyCache.clear();
}

async function resolveKey(keyId: string, nowMs: number, db?: FirestoreLike) {
  const hit = keyCache.get(keyId);
  if (hit && hit.until > nowMs) return hit.rec;
  const rec = await getLaunchKey(keyId, db);
  remember(keyCache, keyId, { rec, until: nowMs + (rec ? KEY_CACHE_MS : UNKNOWN_KEY_CACHE_MS) });
  return rec;
}

async function loadSiteKey(ctx: TenantContext, campaignId: string, nowMs: number, db?: FirestoreLike) {
  const cacheKey = `${ctx.tenantId}/${campaignId}`;
  const hit = siteKeyCache.get(cacheKey);
  if (hit && hit.until > nowMs) return hit.key;
  const key = await forTenant(ctx, db).siteKeys.getById(campaignId);
  remember(siteKeyCache, cacheKey, { key, until: nowMs + SITE_KEY_CACHE_MS });
  return key;
}

export type ResolvedSiteKey = { ctx: TenantContext; key: SiteKey };

/**
 * A site key id → its live key, or null when unknown or revoked. Throws when the
 * control plane can't be read (the caller answers 503, not 401).
 */
export async function resolveSiteKey(keyId: string, nowMs: number, db?: FirestoreLike): Promise<ResolvedSiteKey | null> {
  if (!keyId.startsWith("ygl_")) return null; // not a site key: no read
  const rec = await resolveKey(keyId, nowMs, db);
  if (!rec) return null;
  const ctx: TenantContext = { tenantId: rec.tenantId, region: rec.region, source: "api_key" };
  const key = await loadSiteKey(ctx, rec.campaignId, nowMs, db);
  if (!key || key.status !== "active" || key.keyId !== keyId) return null;
  return { ctx, key };
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of a presented secret against the key's current (and rotating-out) secrets. */
export function siteSecretMatches(key: SiteKey, presented: string, nowMs: number): boolean {
  const given = digest(presented);
  let ok = false;
  for (const secret of siteKeySecrets(key, nowMs)) {
    if (timingSafeEqual(digest(secret), given)) ok = true; // no early exit
  }
  return ok;
}

export type SiteKeyAuth = { ok: true; ctx: TenantContext; key: SiteKey } | { ok: false; status: 401 | 503 };

/** `Authorization: Basic base64(keyId:secret)` → the launch's live key, or why not. */
export async function authenticateSiteKey(header: string | null, nowMs: number, db?: FirestoreLike): Promise<SiteKeyAuth> {
  const creds = parseBasicAuth(header);
  if (!creds) return { ok: false, status: 401 };
  let resolved: ResolvedSiteKey | null;
  try {
    resolved = await resolveSiteKey(creds.keyId, nowMs, db);
  } catch (err) {
    console.error(`[site-signups] key lookup failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return { ok: false, status: 503 };
  }
  if (!resolved) return { ok: false, status: 401 };
  let matches: boolean;
  try {
    matches = siteSecretMatches(resolved.key, creds.secret, nowMs);
  } catch (err) {
    // The sealing key is missing or changed: the server can't check anyone, which isn't the caller's fault.
    console.error(`[site-signups] secret check failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return { ok: false, status: 503 };
  }
  return matches ? { ok: true, ctx: resolved.ctx, key: resolved.key } : { ok: false, status: 401 };
}
