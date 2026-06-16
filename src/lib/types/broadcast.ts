import { z } from "zod";
import { AgentMetaSchema } from "./email";

/**
 * Broadcast — a one-off email send scoped to a single launch (campaign). Lives
 * in the tenant-scoped `broadcasts` collection. Authored in the launch
 * workspace's Broadcasts tab, delivered as a MailChimp Marketing campaign
 * targeted at that launch's audience tag.
 */
export const BroadcastStatus = z.enum([
  "draft",
  "queued",
  "sending",
  "sent",
  "failed",
]);
export type BroadcastStatus = z.infer<typeof BroadcastStatus>;

export const BroadcastStatsSchema = z.object({
  emailsSent: z.number().int().nonnegative().optional(),
  openRate: z.number().optional(),
  clickRate: z.number().optional(),
});
export type BroadcastStats = z.infer<typeof BroadcastStatsSchema>;

export const BroadcastSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  heroImageUrl: z.string().nullable().optional(),
  status: BroadcastStatus,
  /** Set once the MailChimp campaign is created, for report lookups. */
  mailchimpCampaignId: z.string().nullable().optional(),
  stats: BroadcastStatsSchema.nullable().optional(),
  agentMeta: AgentMetaSchema.optional(),
  /** Surfaced to the operator when status === "failed". */
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  sentAt: z.string().nullable().optional(),
});
export type Broadcast = z.infer<typeof BroadcastSchema>;
