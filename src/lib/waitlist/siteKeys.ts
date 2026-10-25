import { randomBytes } from "node:crypto";
import { createSecretBox } from "@/lib/security/secretBox";
import { forTenant, putLaunchKey, deleteLaunchKey, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { SiteKey } from "@/lib/types/siteKey";
import { randomToken, ROTATION_OVERLAP_MS } from "@/lib/connect/keys";

/**
 * A launch's site key (LAUNCH_SITE_SIGNUPS_ENABLED): a public key id and a secret the
 * brand's server sends with POST /api/v2/signups. One per launch. The secret is shown
 * to the operator once, then kept only sealed (AES-256-GCM, bound to
 * `${tenantId}:${campaignId}`) under CONNECT_SECRET_ENC_KEY with its own purpose
 * labels, so a self-hosted copy needs no new secret and a product key's ciphertext
 * can never open as a site key's.
 */
const box = createSecretBox({
  envVar: "CONNECT_SECRET_ENC_KEY",
  encPurpose: "launch-key-secret-v1",
  statePurpose: "launch-key-state-v1",
  unconfiguredError: "connect_enc_key_unconfigured",
});

export function isSiteKeyCryptoConfigured(): boolean {
  return box.isConfigured();
}

export function newSiteKeyId(): string {
  return `ygl_${randomToken(24)}`;
}

export function newSiteSecret(): string {
  return `ygls_${randomBytes(32).toString("base64url")}`;
}

function secretAad(tenantId: string, campaignId: string): string {
  return `${tenantId}:${campaignId}`;
}

/** The start of a secret, shown so an operator can tell secrets apart. */
function prefixOf(secret: string): string {
  return secret.slice(0, 11);
}

/** The plaintext secrets a call may match: the current one, plus the previous one while its rotation overlap lasts. */
export function siteKeySecrets(key: SiteKey, nowMs = Date.now()): string[] {
  if (key.status !== "active") return [];
  const out: string[] = [];
  if (key.secretEnc) out.push(box.open(key.secretEnc, secretAad(key.tenantId, key.campaignId)));
  if (key.prevSecretEnc && key.prevSecretExpiresAt && Date.parse(key.prevSecretExpiresAt) > nowMs) {
    out.push(box.open(key.prevSecretEnc, secretAad(key.tenantId, key.campaignId)));
  }
  return out;
}

/** The UTC Monday (YYYY-MM-DD) of the week `nowMs` falls in. */
export function weekStartOf(nowMs: number): string {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** What the admin screen shows about a launch's key. Never a secret. */
export interface SiteKeyView {
  keyId: string;
  secretPrefix: string;
  status: SiteKey["status"];
  /** The previous secret still works (a rotation in the last 24 hours). */
  rotating: boolean;
  lastUsedAt: string | null;
  /** New sign-ups the key added this week (Monday, UTC). */
  weekSignups: number;
  siteConfirmedUrl: string | null;
  createdAt: string;
}

export function siteKeyView(key: SiteKey, nowMs = Date.now()): SiteKeyView {
  return {
    keyId: key.keyId,
    secretPrefix: key.secretPrefix,
    status: key.status,
    rotating: Boolean(key.prevSecretEnc && key.prevSecretExpiresAt && Date.parse(key.prevSecretExpiresAt) > nowMs),
    lastUsedAt: key.lastUsedAt ?? null,
    weekSignups: key.weekStart === weekStartOf(nowMs) ? (key.weekSignups ?? 0) : 0,
    siteConfirmedUrl: key.siteConfirmedUrl ?? null,
    createdAt: key.createdAt,
  };
}

/**
 * Make a launch's site key. The regional record is written FIRST, then the
 * control-plane routing: if the second write fails, the launch just has no working
 * key (revoke and create again). A revoked key's record is replaced, keeping its
 * Send them to address. Returns the plaintext secret: the ONLY time it is returned.
 */
export async function createSiteKey(
  ctx: TenantContext,
  campaignId: string,
  opts: { createdBy?: string | null; db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ key: SiteKey; secret: string } | { error: "exists" }> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const keyId = newSiteKeyId();
  const secret = newSiteSecret();
  const fresh = {
    campaignId,
    keyId,
    status: "active" as const,
    secretEnc: box.seal(secret, secretAad(ctx.tenantId, campaignId)),
    secretPrefix: prefixOf(secret),
    prevSecretEnc: null,
    prevSecretExpiresAt: null,
    lastUsedAt: null,
    weekStart: null,
    weekSignups: 0,
    createdBy: opts.createdBy ?? null,
    updatedAt: now,
    revokedAt: null,
  };
  let exists = false;
  const { doc } = await forTenant(ctx, opts.db).siteKeys.upsert(
    campaignId,
    () => ({ ...fresh, siteConfirmedUrl: null, createdAt: now }),
    (cur) => {
      if (cur.status === "active") {
        exists = true;
        return null;
      }
      return fresh;
    },
  );
  if (exists) return { error: "exists" };
  await putLaunchKey({ keyId, tenantId: ctx.tenantId, region: ctx.region, campaignId, createdAt: now }, opts.db);
  return { key: doc, secret };
}

/**
 * Issue a new secret. The previous one keeps working for ROTATION_OVERLAP_MS so the
 * brand's server can switch without missing sign-ups. The key id is unchanged.
 * Null when there's no active key.
 */
export async function rotateSiteKey(
  ctx: TenantContext,
  campaignId: string,
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ secret: string } | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const secret = newSiteSecret();
  const updated = await forTenant(ctx, opts.db).siteKeys.claim(campaignId, (cur) => {
    if (cur.status !== "active" || !cur.secretEnc) return null;
    return {
      secretEnc: box.seal(secret, secretAad(ctx.tenantId, campaignId)),
      secretPrefix: prefixOf(secret),
      prevSecretEnc: cur.secretEnc,
      prevSecretExpiresAt: new Date(nowMs + ROTATION_OVERLAP_MS).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
  });
  return updated ? { secret } : null;
}

/**
 * Revoke a launch's key: its routing is deleted FIRST (calls stop at once, bounded
 * by the resolver's cache), then the secrets are destroyed. The record stays,
 * "revoked", for audit. False when there's no active key.
 */
export async function revokeSiteKey(
  ctx: TenantContext,
  campaignId: string,
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<boolean> {
  const repo = forTenant(ctx, opts.db).siteKeys;
  const key = await repo.getById(campaignId);
  if (!key || key.status !== "active") return false;
  await deleteLaunchKey(key.keyId, ctx.tenantId, opts.db);
  const now = new Date(opts.nowMs ?? Date.now()).toISOString();
  await repo.update(campaignId, {
    status: "revoked",
    secretEnc: null,
    prevSecretEnc: null,
    prevSecretExpiresAt: null,
    updatedAt: now,
    revokedAt: now,
  });
  return true;
}

/** Set where people land after confirming. False when the launch has no active key. */
export async function setSiteConfirmedUrl(
  ctx: TenantContext,
  campaignId: string,
  url: string | null,
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<boolean> {
  const updated = await forTenant(ctx, opts.db).siteKeys.claim(campaignId, (cur) =>
    cur.status === "active" ? { siteConfirmedUrl: url, updatedAt: new Date(opts.nowMs ?? Date.now()).toISOString() } : null,
  );
  return updated !== null;
}

/** How often `lastUsedAt` is written: often enough to read "last used", rarely enough to cost nothing. */
const LAST_USED_EVERY_MS = 10 * 60_000;

/**
 * Note a call: `lastUsedAt` (at most every 10 minutes) and, for a new sign-up, this
 * week's count. Best effort: never throws, never fails the call.
 */
export async function recordSiteKeyUse(
  ctx: TenantContext,
  campaignId: string,
  use: { newSignup: boolean },
  opts: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  const week = weekStartOf(nowMs);
  await forTenant(ctx, opts.db)
    .siteKeys.claim(campaignId, (cur) => {
      const stale = !cur.lastUsedAt || nowMs - Date.parse(cur.lastUsedAt) >= LAST_USED_EVERY_MS;
      if (!stale && !use.newSignup) return null;
      const patch: Partial<SiteKey> = {};
      if (stale) patch.lastUsedAt = new Date(nowMs).toISOString();
      if (use.newSignup) {
        patch.weekStart = week;
        patch.weekSignups = (cur.weekStart === week ? (cur.weekSignups ?? 0) : 0) + 1;
      }
      return patch;
    })
    .catch((err) => {
      console.warn(`[site-signups] key use not recorded for ${ctx.tenantId}/${campaignId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
}
