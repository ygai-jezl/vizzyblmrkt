import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { UnsubscribeClaimsV2 } from "./unsubscribeToken";
import { isSuppressed, isSuppressedFor } from "./suppression";

const archiveMember = vi.fn(async () => {});
vi.mock("@/lib/mailchimp", () => ({
  resolveMailchimpConfig: () => ({ ok: true, config: { apiKey: "k", server: "us1", listId: "l" } }),
  archiveMember: (...args: unknown[]) => archiveMember(...(args as [])),
}));

const { applyLifecycleUnsubscribe } = await import("./unsubscribeAction");

const ctx: TenantContext = { tenantId: "ten_a", region: "eu", source: "system" };
const T = "2026-09-21T09:00:00.000Z";

const claims: UnsubscribeClaimsV2 = {
  v: 2,
  tenantId: "ten_a",
  email: "alex@acme.test",
  recipientKind: "product_user",
  recipientId: "pu_1",
  connectionId: "pcn_1",
  category: "onboarding",
  categoryLabel: "Onboarding tips",
  iat: 0,
};

function seed(db: FakeFirestore, userConnectionId = "pcn_1") {
  db.seed("tenants", "ten_a", {
    tenantName: "Acme",
    rootDomain: "acme.test",
    status: "active",
    region: "eu",
    allowedOrigins: [],
    billingTier: "pro",
    ownerId: "usr_1",
    createdAt: T,
    updatedAt: T,
  });
  db.seed("product_users", "pu_1", {
    tenantId: "ten_a",
    connectionId: userConnectionId,
    externalUserId: "user_42",
    email: "alex@acme.test",
    emailNormalized: "alex@acme.test",
    status: "active",
    firstSeenAt: T,
    lastSeenAt: T,
    createdAt: T,
    updatedAt: T,
  });
}

const webhooks = (db: FakeFirestore) => forTenant(ctx, db).lifecycleWebhooks.find();

describe("applyLifecycleUnsubscribe", () => {
  beforeEach(() => archiveMember.mockClear());

  it("category scope: stops that category only, never archives, and tells the product", async () => {
    const db = new FakeFirestore();
    seed(db);
    expect(await applyLifecycleUnsubscribe(claims, "category", "list-unsubscribe", db)).toMatchObject({ ok: true });

    expect(await isSuppressedFor(ctx, "alex@acme.test", "onboarding", db)).toBe(true);
    expect(await isSuppressed(ctx, "alex@acme.test", db)).toBe(false);
    expect(archiveMember).not.toHaveBeenCalled();

    const queued = await webhooks(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      connectionId: "pcn_1",
      type: "email_preferences.updated",
      status: "pending",
      data: { userId: "user_42", category: "onboarding", subscribed: false, scope: "category", source: "list-unsubscribe" },
    });
    // The product gets its own user id — never the address.
    expect(JSON.stringify(queued[0]!.data)).not.toContain("alex@acme.test");
  });

  it("a repeat click records nothing new and queues no second webhook", async () => {
    const db = new FakeFirestore();
    seed(db);
    await applyLifecycleUnsubscribe(claims, "category", "list-unsubscribe", db);
    await applyLifecycleUnsubscribe(claims, "category", "preferences-page", db);
    expect(await webhooks(db)).toHaveLength(1);
  });

  it("all scope: the tenant-wide opt-out, archived from MailChimp, and a webhook saying so", async () => {
    const db = new FakeFirestore();
    seed(db);
    await applyLifecycleUnsubscribe(claims, "all", "preferences-page", db);
    expect(await isSuppressed(ctx, "alex@acme.test", db)).toBe(true);
    expect(await isSuppressedFor(ctx, "alex@acme.test", "anything", db)).toBe(true);
    expect(archiveMember).toHaveBeenCalledTimes(1);
    const queued = await webhooks(db);
    expect(queued.map((w) => w.data.scope)).toEqual(["all"]);
  });

  it("unknown tenant: nothing happens", async () => {
    const db = new FakeFirestore();
    expect(await applyLifecycleUnsubscribe(claims, "category", "list-unsubscribe", db)).toEqual({ ok: false, tenant: null });
    expect(await isSuppressedFor(ctx, "alex@acme.test", "onboarding", db)).toBe(false);
  });

  it("still suppresses, but sends no webhook, when the user belongs to another connection", async () => {
    const db = new FakeFirestore();
    seed(db, "pcn_other");
    await applyLifecycleUnsubscribe(claims, "category", "list-unsubscribe", db);
    expect(await isSuppressedFor(ctx, "alex@acme.test", "onboarding", db)).toBe(true);
    expect(await webhooks(db)).toHaveLength(0);
  });
});
