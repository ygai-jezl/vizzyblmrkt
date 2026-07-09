/**
 * MailChimp Marketing integration. Audience sync (signup/verify/offboard hooks)
 * + campaign delivery (newsletters & journey steps). The transactional path
 * (verification email) goes through MailChimp Transactional / Mandrill in
 * src/lib/email/index.ts, NOT this module.
 */
export { resolveMailchimpConfig, deriveServerPrefix } from "./config";
export {
  subscriberHash,
  upsertMember,
  addTags,
  archiveMember,
  createCampaign,
  setCampaignContent,
  sendCampaign,
  getCampaignStatus,
  getCampaignReport,
  findTagSegmentId,
} from "./client";
export type { CreateCampaignInput, CampaignReport } from "./client";
export {
  syncSignupToAudience,
  syncSignupToWeekly,
  removeSignupFromAudience,
  campaignTag,
  weeklyTag,
} from "./sync";
export type {
  MailchimpResult,
  ResolvedMailchimpConfig,
  MailchimpConfigResult,
  MailchimpConfigError,
  UpsertMemberInput,
  MemberStatus,
} from "./types";
