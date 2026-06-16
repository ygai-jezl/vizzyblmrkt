import { z } from "zod";

/**
 * Core tenant (brand / workspace). Lives in the root-level `tenants` collection.
 * This is the GLOBAL registry — it is the one set of documents that is NOT
 * tenant-scoped, because resolving "which tenant is this request for?" must
 * happen before a tenant context exists. See src/lib/tenant/registry.ts.
 */
export const TenantStatus = z.enum(["active", "suspended", "trial"]);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * Data-residency region. Logical code (decoupled from the physical Firestore
 * location) so the location stays swappable. Each region maps to its own
 * Firestore named database — see src/lib/tenant/region.ts.
 *
 * IMMUTABLE: a tenant's region is set at creation and never changes, because a
 * Firestore database's location cannot be moved. Per-tenant residency — all of
 * a brand's data lives in its one region.
 */
export const Region = z.enum(["us", "eu", "asia"]);
export type Region = z.infer<typeof Region>;

export const TenantSchema = z.object({
  id: z.string(),
  tenantName: z.string(),
  rootDomain: z.string(),
  /**
   * Brand favicon URL, shown at the top of the admin shell. Pulled in
   * automatically at tenant creation (derived from `rootDomain` — see
   * src/lib/tenant/favicon.ts and createTenant). Defaults to "" so tenant
   * documents predating this field still parse; the admin shell then derives a
   * fallback at render time (or shows a monogram).
   */
  faviconUrl: z.string().default(""),
  status: TenantStatus,
  /** Data-residency region. IMMUTABLE once set (see Region). */
  region: Region,
  /** Allow-listed full origins (scheme + host) for CORS / embed / signup gating. */
  allowedOrigins: z.array(z.string()),
  billingTier: z.string(),
  /** Firebase Auth UID of the primary creator. */
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Tenant = z.infer<typeof TenantSchema>;
