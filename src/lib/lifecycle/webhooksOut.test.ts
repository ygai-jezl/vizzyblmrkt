import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { enqueueConnectionWebhook, WEBHOOK_EXPIRY_MS } from "./webhooksOut";

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
