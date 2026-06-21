import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep forTenant/TenantIsolationError real; stub only the control-plane tenant read.
const getTenantById = vi.fn();
vi.mock("@/lib/tenant", async (orig) => ({
  ...(await orig<typeof import("@/lib/tenant")>()),
  getTenantById: (...a: unknown[]) => getTenantById(...a),
}));

const enrichCompany = vi.fn();
vi.mock("@/lib/agents/marketIntel", () => ({
  enrichCompany: (...a: unknown[]) => enrichCompany(...a),
}));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import type { Tenant } from "@/lib/types/tenant";
import { deterministicCompanyId, deterministicContactId } from "./identifiers";
import { processContactEnrichJob } from "./enrichWorker";

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const DOMAIN = "acme.com";
const companyId = deterministicCompanyId(ctx.tenantId, DOMAIN);

function enrichJob(): EmailJob {
  return {
    id: `enrich:company:${companyId}`,
    tenantId: ctx.tenantId,
    campaignId: "camp1",
    type: "contact_enrich",
    status: "processing",
    dedupeKey: `enrich:company:${companyId}`,
    scheduledAt: "t0",
    attempts: 1,
    payload: { companyId, domain: DOMAIN, sampleEmail: "jo@acme.com" },
    createdAt: "t0",
  } as EmailJob;
}

async function seedContact(db: FakeFirestore) {
  const repo = forTenant(ctx, db);
  const id = deterministicContactId(ctx.tenantId, "jo@acme.com");
  await repo.contacts.create(id, {
    contactKey: "jo@acme.com",
    email: "jo@acme.com",
    firstName: "Jo",
    status: "active",
    verified: true,
    consentStatus: "verified_active",
    emailDomain: DOMAIN,
    isCorporateDomain: true,
    companyId: null,
    campaigns: [],
    campaignIds: ["camp1"],
    totalReferred: 0,
    enrichment: { status: "pending", companyId, domain: DOMAIN },
    searchTokens: [],
    firstSeenAt: "t0",
    updatedAt: "t0",
    createdAt: "t0",
  } as never);
  return id;
}

function tenantWith(crmConfig: Tenant["crmConfig"]): Tenant {
  return { id: ctx.tenantId, region: "us", crmConfig } as Tenant;
}

beforeEach(() => {
  getTenantById.mockReset();
  enrichCompany.mockReset();
});

describe("processContactEnrichJob", () => {
  it("enriches and associates contacts when the tenant has opted in (US)", async () => {
    const db = new FakeFirestore();
    const contactId = await seedContact(db);
    getTenantById.mockResolvedValue(tenantWith({ enrichmentEnabled: true } as never));
    enrichCompany.mockResolvedValue({
      profile: { name: "Acme Inc", industry: "SaaS", confidence: 0.9 },
      source: "agent1",
      model: "gemini-3.5-flash",
      groundingUsed: true,
    });

    const outcome = await processContactEnrichJob(ctx, enrichJob(), db);
    expect(outcome).toBe("done");
    expect(enrichCompany).toHaveBeenCalledOnce();

    const repo = forTenant(ctx, db);
    const company = await repo.companies.getById(companyId);
    expect(company?.enrichmentStatus).toBe("enriched");
    expect(company?.name).toBe("Acme Inc");
    expect(company?.contactCount).toBe(1);

    const contact = await repo.contacts.getById(contactId);
    expect(contact?.companyId).toBe(companyId);
    expect(contact?.enrichment.status).toBe("enriched");
    expect(contact?.enrichment.confidence).toBe(0.9);
  });

  it("materialises a pending company and associates WITHOUT spending when not opted in", async () => {
    const db = new FakeFirestore();
    const contactId = await seedContact(db);
    getTenantById.mockResolvedValue(tenantWith({ enrichmentEnabled: false } as never));

    const outcome = await processContactEnrichJob(ctx, enrichJob(), db);
    expect(outcome).toBe("done");
    expect(enrichCompany).not.toHaveBeenCalled();

    const repo = forTenant(ctx, db);
    const company = await repo.companies.getById(companyId);
    expect(company?.enrichmentStatus).toBe("pending");
    const contact = await repo.contacts.getById(contactId);
    expect(contact?.companyId).toBe(companyId); // still linked for the Companies tab
  });

  it("does NOT enrich an EU tenant without a DPA acknowledgement", async () => {
    const db = new FakeFirestore();
    await seedContact(db);
    const euCtx: TenantContext = { ...ctx, region: "eu" };
    getTenantById.mockResolvedValue(
      tenantWith({ enrichmentEnabled: true, gdprDpaVerified: false } as never),
    );

    const outcome = await processContactEnrichJob(euCtx, enrichJob(), db);
    expect(outcome).toBe("done");
    expect(enrichCompany).not.toHaveBeenCalled();
    const company = await forTenant(euCtx, db).companies.getById(companyId);
    expect(company?.enrichmentStatus).toBe("pending");
  });

  it("drops (frees the key) when the daily cap is reached", async () => {
    const db = new FakeFirestore();
    await seedContact(db);
    getTenantById.mockResolvedValue(
      tenantWith({ enrichmentEnabled: true, dailyEnrichCap: 1 } as never),
    );
    // Pre-seed one company already enriched today → cap of 1 is hit.
    await forTenant(ctx, db).companies.create("co_other", {
      domain: "other.com",
      enrichmentStatus: "enriched",
      contactCount: 0,
      searchTokens: [],
      enrichedAt: new Date().toISOString(),
      updatedAt: "t0",
      createdAt: "t0",
    } as never);

    const outcome = await processContactEnrichJob(ctx, enrichJob(), db);
    expect(outcome).toBe("drop");
    expect(enrichCompany).not.toHaveBeenCalled();
  });
});
