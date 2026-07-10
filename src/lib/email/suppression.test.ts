import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { suppressEmail, isSuppressed, suppressionDocId } from "./suppression";

const ctxA: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const ctxB: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };

describe("suppressionDocId", () => {
  it("is deterministic per (tenant, normalized email)", () => {
    expect(suppressionDocId("ten_a", "Jo@Acme.com")).toBe(suppressionDocId("ten_a", "jo@acme.com "));
  });
  it("differs across tenants for the same address (no cross-tenant collision)", () => {
    expect(suppressionDocId("ten_a", "jo@acme.com")).not.toBe(suppressionDocId("ten_b", "jo@acme.com"));
  });
});

describe("suppressEmail / isSuppressed", () => {
  it("records an opt-out and reads it back (case/space-insensitive)", async () => {
    const db = new FakeFirestore();
    expect(await isSuppressed(ctxA, "jo@acme.com", db)).toBe(false);
    await suppressEmail(ctxA, { email: "Jo@Acme.com ", reason: "unsubscribe", source: "footer" }, db);
    expect(await isSuppressed(ctxA, "jo@acme.com", db)).toBe(true);
  });

  it("is idempotent (a repeat opt-out does not throw)", async () => {
    const db = new FakeFirestore();
    await suppressEmail(ctxA, { email: "jo@acme.com", reason: "unsubscribe", source: "footer" }, db);
    await expect(
      suppressEmail(ctxA, { email: "jo@acme.com", reason: "spam", source: "mandrill-spam" }, db),
    ).resolves.toBeUndefined();
    expect(await isSuppressed(ctxA, "jo@acme.com", db)).toBe(true);
  });

  it("is tenant-scoped: suppressing in tenant A does not suppress in tenant B", async () => {
    const db = new FakeFirestore();
    await suppressEmail(ctxA, { email: "jo@acme.com", reason: "unsubscribe", source: "footer" }, db);
    expect(await isSuppressed(ctxB, "jo@acme.com", db)).toBe(false);
  });

  it("ignores blank addresses", async () => {
    const db = new FakeFirestore();
    await suppressEmail(ctxA, { email: "  ", reason: "unsubscribe", source: "footer" }, db);
    expect(await isSuppressed(ctxA, "", db)).toBe(false);
  });
});
