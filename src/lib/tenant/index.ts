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
  resolveTenantForRequest,
  tenantContextFromClaims,
  resolveActiveTenant,
} from "./context";
export type { VerifiedClaims } from "./context";
export {
  getTenantById,
  getTenantByOrigin,
  getTenantsForUser,
  getTenantMembership,
  listAllTenants,
} from "./registry";
export {
  REGION_CONFIGS,
  DEFAULT_DATABASE_ID,
  databaseIdForRegion,
} from "./region";
export type { RegionConfig } from "./region";
export {
  knowledgeChunksRef,
  verifyOwner,
  listKnowledgeChunks,
  deleteOwnerKnowledge,
  KNOWLEDGE_SUBCOLLECTION,
} from "./knowledge";
export type { KnowledgeChunkView } from "./knowledge";
export {
  createTenant,
  backfillTenantFavicon,
  updateTenantConfig,
  updateTenantSenderConfig,
  addTenantMember,
  addAllowedOrigin,
  removeAllowedOrigin,
  logDomainGrant,
} from "./control";
export type { DomainGrantAudit } from "./control";
export {
  recordLaunchDeletion,
  writeAuditObject,
  auditObjectPath,
  auditEntryId,
} from "./audit";
export type { LaunchDeletionAudit, LaunchDeletionCounts } from "./audit";
export { gcsAuditSink } from "./auditSink";
export type { AuditObjectSink } from "./auditSink";
export { deleteLaunch } from "./launchDeletion";
export type { DeleteLaunchResult } from "./launchDeletion";
export { setLaunchArchived } from "./launchArchive";
export type { ArchiveAction, SetArchiveResult } from "./launchArchive";
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
