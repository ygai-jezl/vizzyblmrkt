import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { drainConnectionWebhooks, enqueueConnectionWebhook, webhookBackoffMs, WEBHOOK_EXPIRY_MS } from "./webhooksOut";

const ctxA: TenantContext = { tenantId: "ten_a", region: "eu", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_b", region: "eu", source: "system" };
const NOW = Date.parse("2026-09-21T09:00:00Z");
const input = {
  connectionId: "pcn_1",
  type: "email_preferences.updated" as const,
  data: { userId: "user_42", category: "onboarding", subscribed: false },
  dedupeKey: "unsub:pu_1:onboarding:category",
};

describe("enqueueConnectionWebhook", () => {
  it("queues a pending webhook, due now, that expires after 24h", async () => {
    const db = new FakeFirestore();
    expect(await enqueueConnectionWebhook(ctxA, input, db, NOW)).toBe("queued");
    const [w] = await forTenant(ctxA, db).lifecycleWebhooks.find();
    expect(w).toMatchObject({
      id: expect.stringMatching(/^whq_[0-9a-f]{32}$/),
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + WEBHOOK_EXPIRY_MS).toISOString(),
    });
  });

  it("dedupes on the key", async () => {
    const db = new FakeFirestore();
    await enqueueConnectionWebhook(ctxA, input, db, NOW);
    expect(await enqueueConnectionWebhook(ctxA, input, db, NOW + 1000)).toBe("duplicate");
    expect(await forTenant(ctxA, db).lifecycleWebhooks.find()).toHaveLength(1);
  });

  it("keeps tenants apart", async () => {
    const db = new FakeFirestore();
    await enqueueConnectionWebhook(ctxA, { ...input, connectionId: "pcn_a" }, db, NOW);
    await enqueueConnectionWebhook(ctxB, { ...input, connectionId: "pcn_b" }, db, NOW);
    expect(await forTenant(ctxA, db).lifecycleWebhooks.find()).toHaveLength(1);
    expect(await forTenant(ctxB, db).lifecycleWebhooks.find()).toHaveLength(1);
  });
});

describe("drainConnectionWebhooks", () => {
  const seedConnection = (db: FakeFirestore, status = "active") =>
    db.seed("product_connections", "pcn_1", {
      tenantId: "ten_a",
      name: "P",
      kind: "custom",
      status,
      keyId: "k",
      secretEnc: null,
      secretPrefix: "x",
      webhookEndpoint: { url: "https://p.example.com/hook", enabled: true },
      linkDomains: [],
      catalog: { events: [], traits: [], onboardingSteps: [], glossary: [] },
      consentPolicy: { marketingBases: ["consent"], verifyCorporateDomain: true },
      defaults: { timezone: "Europe/London", locale: "en" },
      health: {},
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });

  it("delivers a due webhook once and marks it done", async () => {
    const db = new FakeFirestore();
    seedConnection(db);
    await enqueueConnectionWebhook(ctxA, input, db, NOW);
    const calls: unknown[] = [];
    const send = async (_c: unknown, event: unknown) => {
      calls.push(event);
      return { ok: true as const, status: 200 };
    };
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW, send })).toEqual({ delivered: 1, failed: 0, expired: 0 });
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW + 3600_000, send })).toEqual({ delivered: 0, failed: 0, expired: 0 });
    const [queued] = await forTenant(ctxA, db).lifecycleWebhooks.find();
    expect(calls).toEqual([
      { id: queued!.id.replace(/^whq_/, "wh_"), createdAt: new Date(NOW).toISOString(), type: "email_preferences.updated", data: input.data },
    ]);
    const [w] = await forTenant(ctxA, db).lifecycleWebhooks.find();
    expect(w).toMatchObject({ status: "done", attempts: 1 });
  });

  it("backs off after a failure and retries when due", async () => {
    const db = new FakeFirestore();
    seedConnection(db);
    await enqueueConnectionWebhook(ctxA, input, db, NOW);
    let ok = false;
    const ids: string[] = [];
    const send = async (_c: unknown, event: { id?: string }) => {
      ids.push(event.id ?? "");
      return ok ? { ok: true as const, status: 200 } : { ok: false as const, error: "http_503" };
    };
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW, send })).toMatchObject({ failed: 1 });
    let [w] = await forTenant(ctxA, db).lifecycleWebhooks.find();
    expect(w).toMatchObject({ status: "pending", attempts: 1, lastError: "http_503", nextAttemptAt: new Date(NOW + webhookBackoffMs(1)).toISOString() });
    // Not due yet: nothing happens.
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW + 30_000, send })).toEqual({ delivered: 0, failed: 0, expired: 0 });
    ok = true;
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW + 61_000, send })).toMatchObject({ delivered: 1 });
    [w] = await forTenant(ctxA, db).lifecycleWebhooks.find();
    expect(w).toMatchObject({ status: "done", attempts: 2 });
    // A retry carries the same id, so the product can drop one it already handled.
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^wh_[0-9a-f]{32}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("drops a webhook past its expiry, or whose connection is gone", async () => {
    const db = new FakeFirestore();
    seedConnection(db, "revoked");
    await enqueueConnectionWebhook(ctxA, input, db, NOW);
    await enqueueConnectionWebhook(ctxA, { ...input, dedupeKey: "other" }, db, NOW - WEBHOOK_EXPIRY_MS - 1000);
    const send = async () => ({ ok: true as const, status: 200 });
    expect(await drainConnectionWebhooks(ctxA, { db, now: () => NOW, send })).toEqual({ delivered: 0, failed: 0, expired: 2 });
  });

  it("backoff grows to a 6-hour ceiling", () => {
    expect(webhookBackoffMs(1)).toBe(60_000);
    expect(webhookBackoffMs(3)).toBe(240_000);
    expect(webhookBackoffMs(20)).toBe(6 * 3600_000);
  });
});
