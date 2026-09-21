import { describe, it, expect } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import {
  categorySuppressionDocId,
  isSuppressed,
  isSuppressedFor,
  suppressEmail,
  suppressEmailCategory,
  suppressionDocId,
} from "./suppression";

const ctxA: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const input = { email: "Alex@Acme.test ", category: "onboarding", source: "list-unsubscribe", connectionId: "pcn_1", recipientId: "pu_1" };

describe("category suppression", () => {
  it("uses a different doc id from the tenant-wide opt-out", () => {
    expect(categorySuppressionDocId("ten_a", "alex@acme.test", "onboarding")).toMatch(/^supc_/);
    expect(categorySuppressionDocId("ten_a", "alex@acme.test", "onboarding")).not.toBe(
      suppressionDocId("ten_a", "alex@acme.test"),
    );
    expect(categorySuppressionDocId("ten_a", "alex@acme.test", "onboarding")).not.toBe(
      categorySuppressionDocId("ten_a", "alex@acme.test", "product_news"),
    );
  });

  it("stops only that category, and does not count as a tenant-wide opt-out", async () => {
    const db = new FakeFirestore();
    await suppressEmailCategory(ctxA, input, db);
    expect(await isSuppressedFor(ctxA, "alex@acme.test", "onboarding", db)).toBe(true);
    expect(await isSuppressedFor(ctxA, "alex@acme.test", "product_news", db)).toBe(false);
    // The waitlist journey worker and broadcasts only check the tenant-wide opt-out.
    expect(await isSuppressed(ctxA, "alex@acme.test", db)).toBe(false);
  });

  it("records the scope and who it was for", async () => {
    const db = new FakeFirestore();
    await suppressEmailCategory(ctxA, input, db);
    const doc = await forTenant(ctxA, db).emailSuppressions.getById(
      categorySuppressionDocId("ten_a", "alex@acme.test", "onboarding"),
    );
    expect(doc).toMatchObject({
      scope: "category",
      category: "onboarding",
      normalizedEmail: "alex@acme.test",
      connectionId: "pcn_1",
      recipientId: "pu_1",
      reason: "unsubscribe",
    });
  });

  it("a tenant-wide opt-out covers every category", async () => {
    const db = new FakeFirestore();
    await suppressEmail(ctxA, { email: "alex@acme.test", reason: "unsubscribe", source: "footer" }, db);
    expect(await isSuppressedFor(ctxA, "alex@acme.test", "onboarding", db)).toBe(true);
    expect(await isSuppressedFor(ctxA, "alex@acme.test", "anything", db)).toBe(true);
  });

  it("is idempotent and tenant-scoped", async () => {
    const db = new FakeFirestore();
    await suppressEmailCategory(ctxA, input, db);
    await expect(suppressEmailCategory(ctxA, input, db)).resolves.toBeUndefined();
    expect(await isSuppressedFor(ctxB, "alex@acme.test", "onboarding", db)).toBe(false);
  });
});
