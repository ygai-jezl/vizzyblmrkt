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
  // Queued for delivery at a future `scheduledAt`; not yet handed to the worker.
  "scheduled",
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
  /** Unique unsubscribes for this broadcast (count, not a rate). */
  unsubscribed: z.number().int().nonnegative().optional(),
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
  /** ISO instant a scheduled send is set for (status === "scheduled"); null once
   *  sent or unscheduled. Mirrors the queued job's `scheduledAt` for display. */
  scheduledAt: z.string().nullable().optional(),
  /** Which audience segment to target. Absent/"launch" ⇒ the launch's waitlist
   *  segment (existing behaviour); "weekly" ⇒ the launch's weekly-newsletter
   *  segment (the opt-in subset that reached a weekly Exit node). */
  audienceMode: z.enum(["launch", "weekly"]).optional(),
  /** Provenance when this broadcast was composed from a workspace hub node. The
   *  content is SNAPSHOT into subject/body at create; these are metadata only. */
  sourceWorkspaceId: z.string().nullable().optional(),
  sourcePlanId: z.string().nullable().optional(),
  sourceHubNodeId: z.string().nullable().optional(),
  createdAt: z.string(),
  sentAt: z.string().nullable().optional(),
});
export type Broadcast = z.infer<typeof BroadcastSchema>;
