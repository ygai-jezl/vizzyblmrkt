/**
 * Public surface of the tenant-isolation layer. Import from "@/lib/tenant"
 * everywhere — never reach into firestore.ts or call Firestore directly.
 */
export { forTenant, TenantCollection, TENANT_FIELD } from "./repository";
export type {
  TenantRepositories,
  FindOptions,
  WhereClause,
} from "./repository";
export {
  resolveTenantFromOrigin,
  tenantContextFromClaims,
} from "./context";
export type { VerifiedClaims } from "./context";
export {
  getTenantById,
  getTenantByOrigin,
  getTenantsForUser,
} from "./registry";
export {
  REGION_CONFIGS,
  DEFAULT_DATABASE_ID,
  databaseIdForRegion,
} from "./region";
export type { RegionConfig } from "./region";
export { createTenant, backfillTenantFavicon } from "./control";
export { deriveFaviconUrl } from "./favicon";
export { creditReferral } from "./referral";
export type { CreditReferralResult } from "./referral";
export { verifySignupByToken } from "./verification";
export type { VerifyResult } from "./verification";
export {
  TenantError,
  TenantNotFoundError,
  TenantIsolationError,
  TenantValidationError,
} from "./errors";
export type { TenantContext } from "./types";
