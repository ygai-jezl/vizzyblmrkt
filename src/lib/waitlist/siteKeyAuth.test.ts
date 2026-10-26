import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { createConnection } from "@/lib/connect/keys";
import { __resetSiteKeyCaches, authenticateSiteKey, invalidateSiteKeyCaches } from "./siteKeyAuth";
import { createSiteKey, revokeSiteKey, rotateSiteKey } from "./siteKeys";

const ctxA: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };
const NOW = Date.parse("2026-10-22T10:00:00Z");
const basic = (keyId: string, secret: string) => `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
beforeEach(() => __resetSiteKeyCaches());

async function setup() {
  const db = new FakeFirestore();
  const r = await createSiteKey(ctxA, "news", { db, nowMs: NOW });
  if ("error" in r) throw new Error(r.error);
  return { db, keyId: r.key.keyId, secret: r.secret };
}

describe("site key auth", () => {
  it("resolves the key to its brand, region and launch from the key alone", async () => {
    const w = await setup();
    const auth = await authenticateSiteKey(basic(w.keyId, w.secret), NOW, w.db);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx).toEqual({ tenantId: "ten_A", region: "eu", source: "api_key" });
    expect(auth.key.campaignId).toBe("news");
  });

  it("refuses a missing header, a wrong secret and an unknown key", async () => {
    const w = await setup();
    expect(await authenticateSiteKey(null, NOW, w.db)).toEqual({ ok: false, status: 401 });
    expect(await authenticateSiteKey("Bearer x", NOW, w.db)).toEqual({ ok: false, status: 401 });
    expect(await authenticateSiteKey(basic(w.keyId, "ygls_wrong"), NOW, w.db)).toEqual({ ok: false, status: 401 });
    expect(await authenticateSiteKey(basic("ygl_unknownunknownunknown12", w.secret), NOW, w.db)).toEqual({ ok: false, status: 401 });
  });

  it("refuses a product key", async () => {
    const db = new FakeFirestore();
    const { connection, secret } = await createConnection(ctxA, { name: "Acme", kind: "custom" }, db);
    expect(await authenticateSiteKey(basic(connection.keyId, secret), NOW, db)).toEqual({ ok: false, status: 401 });
  });

  it("stops working once revoked", async () => {
    const w = await setup();
    await revokeSiteKey(ctxA, "news", { db: w.db });
    invalidateSiteKeyCaches(w.keyId, "ten_A", "news");
    expect(await authenticateSiteKey(basic(w.keyId, w.secret), NOW, w.db)).toEqual({ ok: false, status: 401 });
  });

  it("takes the old secret during a rotation's overlap", async () => {
    const w = await setup();
    const rotated = await rotateSiteKey(ctxA, "news", { db: w.db, nowMs: NOW });
    invalidateSiteKeyCaches(w.keyId, "ten_A", "news");
    expect((await authenticateSiteKey(basic(w.keyId, w.secret), NOW + 60_000, w.db)).ok).toBe(true);
    expect((await authenticateSiteKey(basic(w.keyId, rotated!.secret), NOW + 60_000, w.db)).ok).toBe(true);
  });

  it("answers 503, not 401, when the sealing key is missing", async () => {
    const w = await setup();
    const saved = process.env.CONNECT_SECRET_ENC_KEY;
    delete process.env.CONNECT_SECRET_ENC_KEY;
    try {
      expect(await authenticateSiteKey(basic(w.keyId, w.secret), NOW, w.db)).toEqual({ ok: false, status: 503 });
    } finally {
      process.env.CONNECT_SECRET_ENC_KEY = saved;
    }
  });
});
