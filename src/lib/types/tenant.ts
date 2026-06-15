import { z } from "zod";

/**
 * Core tenant (brand / workspace). Lives in the root-level `tenants` collection.
 * This is the GLOBAL registry — it is the one set of documents that is NOT
 * tenant-scoped, because resolving "which tenant is this request for?" must
 * happen before a tenant context exists. See src/lib/tenant/registry.ts.
 */
export const TenantStatus = z.enum(["active", "suspended", "trial"]);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const TenantSchema = z.object({
  id: z.string(),
  tenantName: z.string(),
  rootDomain: z.string(),
  status: TenantStatus,
  /** Allow-listed full origins (scheme + host) for CORS / embed / signup gating. */
  allowedOrigins: z.array(z.string()),
  billingTier: z.string(),
  /** Firebase Auth UID of the primary creator. */
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Tenant = z.infer<typeof TenantSchema>;
