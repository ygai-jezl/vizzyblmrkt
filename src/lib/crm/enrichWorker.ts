import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import type { Company } from "@/lib/types/company";
import type { TenantRepositories } from "@/lib/tenant/repository";
import { enrichCompany } from "@/lib/agents/marketIntel";
import { canonicalDomain } from "./identifiers";
import { buildSearchTokens } from "./searchTokens";

/** Default per-tenant daily cap on ACTUAL Gemini enrichment spend (§H3). */
const DEFAULT_DAILY_ENRICH_CAP = 100;

type JobOutcome = "done" | "drop";

/**
 * Link every contact at this company's domain to the company, and (when the
 * company is enriched) propagate the enrichment snapshot onto each contact.
 * Also refreshes the denormalised contactCount.
 */
async function associateContacts(
  repo: TenantRepositories,
  company: Company,
  confidence: number | null = null,
): Promise<void> {
  const enriched = company.enrichmentStatus === "enriched";
  const contacts = await repo.contacts.find({
    where: [["emailDomain", "==", company.domain]],
  });
  for (const c of contacts) {
    const patch: Record<string, unknown> = {};
    if (c.companyId !== company.id) patch.companyId = company.id;
    const e = c.enrichment;
    const needsEnrichment = e.companyId !== company.id || (enriched && e.status !== "enriched");
    if (needsEnrichment) {
      patch.enrichment = {
        ...e,
        companyId: company.id,
        domain: company.domain,
        status: enriched ? "enriched" : e.status === "none" ? "pending" : e.status,
        source: enriched ? "agent1" : e.source,
        confidence: enriched ? confidence : e.confidence,
        enrichedAt: enriched ? company.enrichedAt ?? null : e.enrichedAt,
      };
    }
    if (Object.keys(patch).length > 0) await repo.contacts.update(c.id, patch);
  }
  await repo.companies.update(company.id, {
    contactCount: contacts.length,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Process a `contact_enrich` job. Always materialises the company doc and
 * associates contacts (so the Companies tab populates even when enrichment is
 * gated off); calls Agent 1 only when the tenant opted in, the region/DPA gate
 * passes, and the per-tenant daily cap has room. Idempotent: an already-enriched
 * company short-circuits with no Gemini spend. Returns "drop" when capped so a
 * later signup at the same company re-enqueues and retries.
 */
export async function processContactEnrichJob(
  ctx: TenantContext,
  job: EmailJob,
  db?: FirestoreLike,
): Promise<JobOutcome> {
  const companyId = String(job.payload.companyId ?? "");
  const domain = canonicalDomain(String(job.payload.domain ?? ""));
  const sampleEmail = job.payload.sampleEmail ? String(job.payload.sampleEmail) : null;
  if (!companyId || !domain) return "done"; // malformed payload — nothing to enrich

  const repo = forTenant(ctx, db);
  const now = new Date().toISOString();

  let company = await repo.companies.getById(companyId);
  if (!company) {
    try {
      company = await repo.companies.create(companyId, {
        domain,
        name: null,
        enrichmentStatus: "pending",
        profile: null,
        contactCount: 0,
        searchTokens: buildSearchTokens([domain]),
        updatedAt: now,
        createdAt: now,
      } as never);
    } catch {
      company = await repo.companies.getById(companyId); // raced create — re-read
    }
  }
  if (!company) return "done";

  // Already done — just (re)associate any newly-arrived contacts, no spend.
  if (company.enrichmentStatus === "enriched" || company.enrichmentStatus === "manual") {
    await associateContacts(repo, company, company.profile?.confidence ?? null);
    return "done";
  }

  // Gating: tenant opt-in + EU DPA. When blocked, keep company pending + linked.
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const crm = tenant?.crmConfig;
  const enrichmentEnabled = crm?.enrichmentEnabled === true;
  const regionOk = ctx.region === "us" || crm?.gdprDpaVerified === true;
  if (!enrichmentEnabled || !regionOk) {
    await associateContacts(repo, company);
    return "done";
  }

  // Per-tenant daily cap on real Gemini spend (count of companies enriched today).
  const cap = crm?.dailyEnrichCap ?? DEFAULT_DAILY_ENRICH_CAP;
  const startOfDay = `${now.slice(0, 10)}T00:00:00.000Z`;
  const enrichedToday = await repo.companies.count([["enrichedAt", ">=", startOfDay]]);
  if (enrichedToday >= cap) {
    await associateContacts(repo, company);
    return "drop"; // free the key → retried after the daily window resets
  }

  await repo.companies.update(companyId, {
    enrichmentStatus: "processing",
    lastEnrichAttemptAt: now,
  });

  const result = await enrichCompany({
    region: ctx.region,
    domain,
    sampleEmail,
    // Localize the enrichment prose to the brand's default content language
    // (independent of `region`); unset ⇒ English.
    language: tenant?.defaultLocale ?? null,
  });

  if (result.source === "agent1" && result.profile) {
    const profile = result.profile;
    await repo.companies.update(companyId, {
      name: profile.name ?? null,
      enrichmentStatus: "enriched",
      profile,
      source: "agent1",
      model: result.model,
      groundingUsed: result.groundingUsed,
      searchTokens: buildSearchTokens([profile.name, domain, profile.industry]),
      enrichedAt: new Date().toISOString(),
      lastError: null,
    });
    const fresh = (await repo.companies.getById(companyId)) ?? company;
    await associateContacts(repo, fresh, profile.confidence ?? null);
    return "done";
  }

  // Unconfigured / parse-failed: stay pending (auto-heals on a later run once
  // Gemini is configured); never throw — enrichment is best-effort.
  await repo.companies.update(companyId, {
    enrichmentStatus: "pending",
    lastError: result.reason ?? "unavailable",
  });
  await associateContacts(repo, company);
  return "done";
}
