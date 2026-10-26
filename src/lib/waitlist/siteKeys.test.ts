import { describe, it, expect, beforeAll } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, getLaunchKey } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { SiteKey } from "@/lib/types/siteKey";
import { ROTATION_OVERLAP_MS } from "@/lib/connect/keys";
import {
  createSiteKey,
  recordSiteKeyUse,
  revokeSiteKey,
  rotateSiteKey,
  setSiteConfirmedUrl,
  siteKeySecrets,
  siteKeyView,
  weekStartOf,
} from "./siteKeys";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const NOW = Date.parse("2026-10-22T10:00:00Z"); // a Thursday

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});

async function keyOf(db: FakeFirestore, ctx = ctxA, campaignId = "news"): Promise<SiteKey> {
  const key = await forTenant(ctx, db).siteKeys.getById(campaignId);
  if (!key) throw new Error("no key");
  return key;
}

describe("site keys", () => {
  it("creates the regional key and its routing, returning the secret once", async () => {
    const db = new FakeFirestore();
    const r = await createSiteKey(ctxA, "news", { createdBy: "usr_1", db, nowMs: NOW });
    if ("error" in r) throw new Error(r.error);
    expect(r.key.keyId).toMatch(/^ygl_[a-z2-7]{24}$/);
    expect(r.secret).toMatch(/^ygls_[A-Za-z0-9_-]{43}$/);
    expect(r.key.secretPrefix).toBe(r.secret.slice(0, 11));
    expect(JSON.stringify(db.raw("launch_site_keys", "news"))).not.toContain(r.secret);
    expect(await getLaunchKey(r.key.keyId, db)).toMatchObject({ tenantId: "ten_A", region: "eu", campaignId: "news" });
    expect(siteKeySecrets(await keyOf(db), NOW)).toEqual([r.secret]);
  });

  it("refuses a second key while one is active", async () => {
    const db = new FakeFirestore();
    await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    expect(await createSiteKey(ctxA, "news", { db, nowMs: NOW })).toEqual({ error: "exists" });
  });

  it("a ciphertext copied to another brand's launch doesn't open", async () => {
    const db = new FakeFirestore();
    await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    const stolen = { ...(await keyOf(db)), tenantId: "ten_B" };
    expect(() => siteKeySecrets(stolen, NOW)).toThrow();
  });

  it("rotates: the old secret works for the overlap, then only the new one", async () => {
    const db = new FakeFirestore();
    const r = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    if ("error" in r) throw new Error(r.error);
    const rotated = await rotateSiteKey(ctxA, "news", { db, nowMs: NOW });
    expect(rotated).not.toBeNull();
    const key = await keyOf(db);
    expect(key.keyId).toBe(r.key.keyId);
    expect(siteKeySecrets(key, NOW + 1000).sort()).toEqual([r.secret, rotated!.secret].sort());
    expect(siteKeySecrets(key, NOW + ROTATION_OVERLAP_MS + 1)).toEqual([rotated!.secret]);
    expect(siteKeyView(key, NOW + 1000).rotating).toBe(true);
  });

  it("revokes: routing gone first, secrets destroyed, record kept", async () => {
    const db = new FakeFirestore();
    const r = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    if ("error" in r) throw new Error(r.error);
    expect(await revokeSiteKey(ctxA, "news", { db, nowMs: NOW })).toBe(true);
    expect(await getLaunchKey(r.key.keyId, db)).toBeNull();
    const key = await keyOf(db);
    expect(key).toMatchObject({ status: "revoked", secretEnc: null, prevSecretEnc: null });
    expect(siteKeySecrets(key, NOW)).toEqual([]);
    expect(await rotateSiteKey(ctxA, "news", { db, nowMs: NOW })).toBeNull();
    expect(await revokeSiteKey(ctxA, "news", { db, nowMs: NOW })).toBe(false);
  });

  it("a key made again after a revoke is new, and keeps Send them to", async () => {
    const db = new FakeFirestore();
    const first = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    if ("error" in first) throw new Error(first.error);
    await setSiteConfirmedUrl(ctxA, "news", "https://example.com/thanks", { db });
    await revokeSiteKey(ctxA, "news", { db });
    const second = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    if ("error" in second) throw new Error(second.error);
    expect(second.key.keyId).not.toBe(first.key.keyId);
    expect(await getLaunchKey(first.key.keyId, db)).toBeNull();
    expect(await getLaunchKey(second.key.keyId, db)).not.toBeNull();
    expect((await keyOf(db)).siteConfirmedUrl).toBe("https://example.com/thanks");
  });

  it("another brand can't see, rotate, revoke or change the key", async () => {
    const db = new FakeFirestore();
    await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    expect(await forTenant(ctxB, db).siteKeys.getById("news")).toBeNull();
    expect(await rotateSiteKey(ctxB, "news", { db })).toBeNull();
    expect(await revokeSiteKey(ctxB, "news", { db })).toBe(false);
    expect(await setSiteConfirmedUrl(ctxB, "news", "https://example.com/x", { db })).toBe(false);
    expect((await keyOf(db)).status).toBe("active");
  });

  it("Send them to needs an active key", async () => {
    const db = new FakeFirestore();
    expect(await setSiteConfirmedUrl(ctxA, "news", "https://example.com/thanks", { db })).toBe(false);
  });

  it("counts this week's sign-ups and writes last used at most every 10 minutes", async () => {
    const db = new FakeFirestore();
    await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    await recordSiteKeyUse(ctxA, "news", { newSignup: true }, { db, nowMs: NOW });
    await recordSiteKeyUse(ctxA, "news", { newSignup: false }, { db, nowMs: NOW + 60_000 });
    await recordSiteKeyUse(ctxA, "news", { newSignup: true }, { db, nowMs: NOW + 120_000 });
    let key = await keyOf(db);
    expect(key.lastUsedAt).toBe(new Date(NOW).toISOString());
    expect(siteKeyView(key, NOW + 120_000).weekSignups).toBe(2);
    await recordSiteKeyUse(ctxA, "news", { newSignup: false }, { db, nowMs: NOW + 11 * 60_000 });
    key = await keyOf(db);
    expect(key.lastUsedAt).toBe(new Date(NOW + 11 * 60_000).toISOString());
    // A new week starts the count again.
    const nextWeek = NOW + 7 * 86_400_000;
    expect(siteKeyView(key, nextWeek).weekSignups).toBe(0);
    await recordSiteKeyUse(ctxA, "news", { newSignup: true }, { db, nowMs: nextWeek });
    expect(siteKeyView(await keyOf(db), nextWeek).weekSignups).toBe(1);
  });

  it("the view never carries a secret", async () => {
    const db = new FakeFirestore();
    const r = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
    if ("error" in r) throw new Error(r.error);
    const view = siteKeyView(await keyOf(db), NOW);
    expect(JSON.stringify(view)).not.toContain(r.secret);
    expect(view).not.toHaveProperty("secretEnc");
  });

  it("weeks start on Monday, UTC", () => {
    expect(weekStartOf(Date.parse("2026-10-22T10:00:00Z"))).toBe("2026-10-19");
    expect(weekStartOf(Date.parse("2026-10-19T00:00:00Z"))).toBe("2026-10-19");
    expect(weekStartOf(Date.parse("2026-10-25T23:59:59Z"))).toBe("2026-10-19");
  });
});
