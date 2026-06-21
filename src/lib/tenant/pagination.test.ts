import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant } from "./repository";
import type { TenantContext } from "./types";

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };

/**
 * Keyset pagination via FindOptions.startAfter — proves the new cursor honours
 * firebase-admin startAfter() semantics (results begin strictly AFTER the
 * supplied order tuple) so CRM list pages don't skip or duplicate rows.
 */
describe("TenantCollection cursor pagination (startAfter)", () => {
  it("pages through results without overlap", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctx, db);
    for (let i = 0; i < 5; i++) {
      await repo.contacts.create(`ct_${i}`, {
        contactKey: `k${i}`,
        status: "active",
        verified: false,
        consentStatus: "unverified_signup",
        campaigns: [],
        campaignIds: [],
        totalReferred: 0,
        enrichment: { status: "none" },
        searchTokens: [],
        firstSeenAt: `2026-01-0${i}`,
        updatedAt: `2026-01-0${i}`,
        createdAt: `2026-01-0${i}`,
      } as never);
    }

    const page1 = await repo.contacts.find({
      orderBy: [["createdAt", "desc"]],
      limit: 2,
    });
    expect(page1.map((c) => c.id)).toEqual(["ct_4", "ct_3"]);

    const page2 = await repo.contacts.find({
      orderBy: [["createdAt", "desc"]],
      startAfter: [page1[page1.length - 1]!.createdAt],
      limit: 2,
    });
    expect(page2.map((c) => c.id)).toEqual(["ct_2", "ct_1"]);

    const page3 = await repo.contacts.find({
      orderBy: [["createdAt", "desc"]],
      startAfter: [page2[page2.length - 1]!.createdAt],
      limit: 2,
    });
    expect(page3.map((c) => c.id)).toEqual(["ct_0"]);
  });

  it("excludes the cursor row itself (strictly-after)", async () => {
    const db = new FakeFirestore();
    const repo = forTenant(ctx, db);
    for (let i = 0; i < 3; i++) {
      await repo.companies.create(`co_${i}`, {
        domain: `d${i}.com`,
        enrichmentStatus: "pending",
        contactCount: 0,
        searchTokens: [],
        updatedAt: `2026-02-0${i}`,
        createdAt: `2026-02-0${i}`,
      } as never);
    }
    const after = await repo.companies.find({
      orderBy: [["updatedAt", "asc"]],
      startAfter: ["2026-02-00"],
    });
    expect(after.map((c) => c.id)).toEqual(["co_1", "co_2"]);
  });
});
