/**
 * Public surface of the tenant-isolation layer. Import from "@/lib/tenant"
 * everywhere — never reach into firestore.ts or call Firestore directly.
 */
export { forTenant, TenantCollection, TENANT_FIELD } from "./repository";
export type {
  TenantRepositories,
  FindOptions,
  WhereClause,
  UpdatePatch,
  UpdateWhereResult,
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
  getTenantsByMailchimpAudience,
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
  listKnowledgePages,
  deleteOwnerKnowledge,
  setKnowledgeTags,
  KNOWLEDGE_SUBCOLLECTION,
} from "./knowledge";
export type { KnowledgeChunkView, KnowledgePage } from "./knowledge";
export {
  performanceExemplarsRef,
  writePerformanceExemplar,
  PERFORMANCE_EXEMPLARS,
} from "./exemplars";
export {
  postPerformanceRef,
  upsertPostMetricSnapshot,
  writePostMeasurement,
  writePostReward,
  readPostPerformance,
  readPostPerformanceMany,
  listSettledForReward,
  listBaselineCohort,
  listScoredForChannel,
  POST_PERFORMANCE,
} from "./postPerformance";
export type { PostPerformanceBase } from "./postPerformance";
export {
  writePostPerfVector,
  findNearestPostVectors,
  POST_PERF_VECTORS,
} from "./postVectors";
export type { PostPerfVectorRow, PostPerfNeighbor } from "./postVectors";
export {
  createTenant,
  backfillTenantFavicon,
  updateTenantConfig,
  sealTenantMailchimpKey,
  updateTenantSenderConfig,
  addTenantMember,
  addAllowedOrigin,
  removeAllowedOrigin,
  logDomainGrant,
  setTenantGitConnection,
  deleteTenantGitConnection,
  setTenantGitRepos,
  swapTenantGitToken,
  markTenantGitReconnect,
  clearTenantGitReconnect,
  setTenantSocialConnection,
  swapTenantSocialToken,
  deleteTenantSocialConnection,
  setSocialSubscription,
  getSocialSubscription,
  deleteSocialSubscription,
  setTenantLearnedChannelPatterns,
} from "./control";
export type { DomainGrantAudit, SocialSubscription } from "./control";
export {
  ORGANISATIONS,
  ORGANISATION_CHANGES,
  organisationIdFor,
  getOrganisation,
  listOrganisations,
  ensureBrandOrganisation,
  attachBrandToOrganisation,
  moveBrandToNewOrganisation,
  setOrganisationPlan,
  setOrganisationName,
  setOrganisationOwners,
  organisationUserIds,
  OPERATOR_LABEL,
  scriptActor,
  organisationDrift,
  hasDrift,
} from "./organisations";
export type { DriftBrand, EnsureOrganisationOptions, EnsureOrganisationResult, OrganisationDrift, SetPlanResult } from "./organisations";
export { countLiveLaunches } from "./liveLaunches";
export {
  appendPatternVersion,
  listPatternVersions,
  getPatternVersion,
  LEARNED_PATTERN_VERSIONS,
} from "./patternVersions";
export {
  writeTrendingTopics,
  readTrendingTopics,
  readTrendingTopicsRaw,
  TRENDING_TOPICS,
} from "./trendingTopics";
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
export {
  putConnectionKey,
  getConnectionKey,
  deleteConnectionKey,
} from "./connectionKeys";
export type { ConnectionKeyRecord } from "./connectionKeys";
export { putLaunchKey, getLaunchKey, deleteLaunchKey } from "./launchKeys";
export type { LaunchKeyRecord } from "./launchKeys";
export { applyProductMessage } from "./productIngest";
export type { ApplyOutcome, ApplyMessageArgs } from "./productIngest";
export { isRateLimited } from "./rateLimit";
export { claimLifecycleSend } from "./lifecycleSend";
// The event history: context-level writers only. The raw transaction helpers stay in src/lib/tenant.
export {
  appendEvents,
  writeRecordWithEvents,
  blankFieldEvents,
  countFieldEvents,
  eraseHistory,
  repointHistoryPage,
} from "./ontologyEvents";
export type {
  RecordCollection,
  RecordOf,
  RecordPlan,
  RecordWriteResult,
  BlankOptions,
  BlankResult,
  HistoryStore,
  HistoryKey,
  RepointResult,
} from "./ontologyEvents";
// Agent actions: one record per suggestion and its agent.* trail. The transaction helpers stay in src/lib/tenant.
export {
  proposeAgentAction,
  transitionAgentAction,
  clearAgentActionDetails,
  expireAgentActions,
  blankFieldInAgentActions,
  countFieldAgentActions,
} from "./agentActions";
export type { AgentProposal, AgentTransition, TransitionError } from "./agentActions";
// The settings log: a setting and its version in one transaction (read the versions through forTenant).
export { commitSettingsChange, readSetting, settingsDocId, settingsVersionId } from "./settingsLog";
export type { SettingsChange, SettingsCommit, StoredSetting } from "./settingsLog";
// Field values: the one writer, with their events, tags and an agent action's decision in one transaction.
export { setRecordFieldValues, repairFieldTags, moveRecordFieldValues, RECORD_BYTE_BUDGET } from "./recordFieldWrites";
export type { SetFieldValuesInput, SetFieldValuesResult, SetFieldValuesError } from "./recordFieldWrites";
export type { VersionCollection, ConnectionRecords, ActivityLog } from "./repository";
// Connected data: a connection and its activity in one transaction (read the records through forTenant).
export {
  createDataConnection,
  changeDataConnection,
  purgeDataConnection,
  countDataConnectionActivity,
  ACTIVITY_KEEP_DAYS,
  RECENT_LIMIT,
} from "./dataConnections";
export type { ActivityWrite, NewDataConnection, DataConnectionPatch, ChangePlan, ChangeResult, PurgeCounts } from "./dataConnections";
// Connected data sign in states: made at Sign in, claimed once by the callback, then deleted.
export { createConnectionState, consumeConnectionState, STATE_VALID_MS } from "./dataConnectionStates";
export type { NewConnectionState, StoredConnectionState, ConsumeOutcome } from "./dataConnectionStates";
export type { SendClaimArgs, SendClaimOutcome } from "./lifecycleSend";
export type { RateLimitConfig } from "./rateLimit";
