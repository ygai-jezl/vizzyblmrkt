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
  organisationMembership,
  listOrganisations,
  ensureBrandOrganisation,
  attachBrandToOrganisation,
  moveBrandToNewOrganisation,
  reusableOrganisationId,
  setOrganisationPlan,
  setOrganisationName,
  setOrganisationOwners,
  organisationUserIds,
  recordOrganisationConnectionChange,
  OPERATOR_LABEL,
  scriptActor,
  organisationDrift,
  hasDrift,
} from "./organisations";
export type { AttachGuards, DriftBrand, EnsureOrganisationOptions, EnsureOrganisationResult, OrganisationConnectionChangeKind, OrganisationDrift, SetPlanResult } from "./organisations";
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
  recordFieldErase,
  writeAuditObject,
  auditObjectPath,
  auditEntryId,
} from "./audit";
export type { AuditEntry, FieldEraseAudit, LaunchDeletionAudit, LaunchDeletionCounts } from "./audit";
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
// A fact Vizzy heard in a chat, kept with its decision and the chat's lines in one transaction.
export { keepSuggestedBusinessFact } from "./businessFacts";
export type { KeepBusinessFactInput, KeepBusinessFactResult } from "./businessFacts";
// Home's Your next action: the card per brand in its region, each step's decision in the same transaction.
export {
  readNextActionCard,
  claimNextActionWrite,
  releaseNextActionWrite,
  commitNextActionWrite,
  recordNextActionOutcome,
  forgetNextActionCard,
  trimOutcomes,
} from "./nextActionCards";
export type { ClaimResult, CommitResult, NextActionWrite, OutcomeInput, OutcomeError, OutcomeResult } from "./nextActionCards";
// The settings log: a setting and its version in one transaction (read the versions through forTenant).
export { commitSettingsChange, readSetting, settingsDocId, settingsVersionId } from "./settingsLog";
export type { SettingsChange, SettingsCommit, StoredSetting } from "./settingsLog";
// Only me views on People (piece C): the signed in member's own, saved with a rev check.
export { readMemberViews, commitMemberViews, memberViewsDocId } from "./memberViews";
export type { StoredMemberViews, MemberViewsCommit } from "./memberViews";
// Field values: the one writer, with their events, tags and an agent action's decision in one transaction.
export { setRecordFieldValues, repairFieldTags, moveRecordFieldValues, eraseFieldValuesPage, RECORD_BYTE_BUDGET } from "./recordFieldWrites";
export type { SetFieldValuesInput, SetFieldValuesResult, SetFieldValuesError, EraseFieldValuesPage } from "./recordFieldWrites";
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
// Organisation connections (Connectors 3): an organisation's sign in in the region it was
// connected from, and each brand's part as a brand record in its own region, given, changed and
// ended in three steps over two databases. The stage variants stay in src/lib/tenant.
export {
  ORGANISATION_CONNECTIONS,
  ORGANISATION_CONNECTION_ACTIVITY,
  REPAIR_AFTER_MS,
  provisionedRegions,
  newOrganisationConnectionId,
  createOrganisationConnection,
  getOrganisationConnection,
  findOrganisationConnection,
  listOrganisationConnections,
  listRegionOrganisationConnections,
  pageRegionOrganisationConnections,
  scanRegionOrganisationConnections,
  changeOrganisationConnection,
  countOrganisationConnectionActivity,
  purgeOrganisationConnection,
  givePart,
  changePart,
  endPart,
  removePartEntry,
  disconnectOrganisationConnectionRecord,
  repairParts,
} from "./organisationConnections";
export type {
  OrganisationStores,
  OrgActivityWrite,
  NewOrganisationConnection,
  OrganisationConnectionPatch,
  OrgChangePlan,
  OrgChangeResult,
  OrganisationPurgeCounts,
  OrganisationConnectionPage,
  SourceRef,
  BrandRef,
  StepTwoStage,
  GivePartInput,
  GivePartResult,
  ChangePartInput,
  ChangePartResult,
  EndPartInput,
  EndPartResult,
  RepairOutcome,
} from "./organisationConnections";
// Work (ADR-0020): an organisation's tasks and daily log, in regional databases, and its task counter.
export {
  WORK_TASKS,
  WORK_LOG,
  newWorkTaskId,
  newWorkLogId,
  newWorkImportId,
  createWorkTask,
  changeWorkTask,
  deleteWorkTask,
  appendWorkLog,
  getWorkTask,
  findWorkTask,
  findWorkTaskByRef,
  listWorkTasks,
  listWorkChecks,
  countWorkTasks,
  listWorkLog,
  listTaskLog,
  listTaskDecisions,
  countWorkLog,
  eraseOrganisationWork,
  repointBrandWork,
  countBrandWork,
  brandWorkHome,
  createSuggestedWorkTask,
  saveDraftedWorkLog,
  findWorkLogRow,
} from "./work";
export type { WorkStores, WorkWrite, NewWorkTask, WorkTaskPatch, WorkChangePlan, WorkChangeResult, NewWorkLogRow, WorkRead, WorkEraseCounts, SuggestionAccept, SuggestedTaskResult, DraftAccept, DraftedRowResult } from "./work";
export { WORK_REFS, IMPORT_HOLD_MS, allocateWorkRefs, raiseWorkRefs, peekWorkRefs, peekImportRefs, claimImportRefs, releaseImportRefs, deleteWorkRefs } from "./workRefs";
export type { ImportRefsPeek } from "./workRefs";
// Who may act for an organisation, read live.
export { organisationContextFor, verifiedPersonOf, isBrandAdminLive, isBrandAdminByRow, mayMoveBrand } from "./organisationContext";
export type { BrandMoveCheck, BrandMoveRefusal, OrganisationContext, VerifiedPerson } from "./organisationContext";
// Connected data sign in states: made at Sign in, claimed once by the callback, then deleted.
export { createConnectionState, consumeConnectionState, STATE_VALID_MS } from "./dataConnectionStates";
export type { NewConnectionState, StoredConnectionState, ConsumeOutcome } from "./dataConnectionStates";
// Emailed codes and links for password sign-in: one hashed code and one hashed link per account,
// each checked in a transaction.
export {
  putEmailCode,
  checkEmailCode,
  claimEmailCodeSend,
  deleteEmailCode,
  putEmailLink,
  checkEmailLink,
  deleteEmailLink,
  EMAIL_CODE_VALID_MS,
  EMAIL_CODE_MAX_TRIES,
  EMAIL_CODE_SENDS_PER_HOUR,
  EMAIL_CODE_WRONG_PER_DAY,
  EMAIL_LINK_VALID_MS,
} from "./emailCodes";
export type { EmailCodeCheck, EmailCodeSendClaim, EmailLinkCheck } from "./emailCodes";
export type { SendClaimArgs, SendClaimOutcome } from "./lifecycleSend";
export type { RateLimitConfig } from "./rateLimit";
