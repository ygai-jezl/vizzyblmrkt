import { z } from "zod";

/**
 * Company — one record per CANONICAL registrable domain per tenant, shared
 * across all of that company's contacts. Lives in the tenant-scoped regional
 * `companies` collection (PII residency, like signups). The `profile` is the
 * Market Intelligence Agent (Agent 1) output; the rest is bookkeeping +
 * denormalised rollups for the Companies table.
 */

/**
 * Agent 1's structured company profile. ALSO the agent function's zod return
 * type (validated via safeParse before persisting). All fields nullable so a
 * partial profile stores cleanly and stays trivially enrichable later. String
 * fields are bounded + plaintext (no HTML) — see src/lib/agents/marketIntel.ts.
 */
export const CompanyProfileSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  industry: z.string().max(200).nullable().optional(),
  employeeRange: z.string().max(40).nullable().optional(), // "11-50", "201-500"
  estimatedEmployees: z.number().int().nonnegative().nullable().optional(),
  hqLocation: z.string().max(200).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  foundedYear: z.number().int().nullable().optional(),
  fundingStage: z.string().max(80).nullable().optional(), // "Seed", "Series B", "Public"
  totalFundingUsd: z.number().nonnegative().nullable().optional(),
  website: z.string().max(400).nullable().optional(),
  socials: z
    .object({
      linkedin: z.string().max(400).nullable().optional(),
      twitter: z.string().max(400).nullable().optional(),
      crunchbase: z.string().max(400).nullable().optional(),
    })
    .partial()
    .optional(),
  /** 0–1 self-reported confidence; low-confidence results may be discarded. */
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const CompanyEnrichmentStatus = z.enum([
  "pending", // queued / awaiting a (re)enrich job
  "processing", // a worker is enriching now
  "enriched", // profile attached
  "failed", // enrichment errored
  "manual", // human-edited; do not auto-overwrite
]);
export type CompanyEnrichmentStatus = z.infer<typeof CompanyEnrichmentStatus>;

export const CompanySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Canonical registrable domain (ASCII/punycode) — the per-tenant dedupe key. */
  domain: z.string(),
  /** Hoisted from profile.name for table sort/search without reading `profile`. */
  name: z.string().nullable().optional(),
  enrichmentStatus: CompanyEnrichmentStatus,
  profile: CompanyProfileSchema.nullable().optional(),
  source: z.enum(["agent1", "manual", "import"]).nullable().optional(),
  model: z.string().nullable().optional(), // the Gemini model id used for enrichment
  /** Whether Google Search grounding actually ran for this profile. */
  groundingUsed: z.boolean().optional(),
  /** Denormalised count of contacts associated to this company. */
  contactCount: z.number().int().nonnegative().default(0),
  /** Lowercased name/domain fragments for array-contains search (no full-text). */
  searchTokens: z.array(z.string()).default([]),
  /** Guards the per-company 24h re-enrich window against storms (§H3). */
  lastEnrichAttemptAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  enrichedAt: z.string().nullable().optional(),
  /** Storage-limitation purge boundary (nullable = keep). */
  retentionUntil: z.string().nullable().optional(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Company = z.infer<typeof CompanySchema>;
