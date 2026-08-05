import { z } from "zod";

/**
 * Grounded trending-topics snapshot for a tenant (LinkedIn/X expose no trends API, so we research
 * them via Gemini + Google Search). One "latest" doc per tenant in `trending_topics` (regional).
 * Injected as an OPTIONAL topicality hint into Create generation, and used to stamp how on-trend a
 * post was at author time (a stored covariate — NOT a reward term in v1). Expires so a stale list
 * never steers content.
 */
export const TrendMomentum = z.enum(["rising", "hot", "fading"]);
export type TrendMomentum = z.infer<typeof TrendMomentum>;

export const TrendingTopicSchema = z.object({
  label: z.string().max(120),
  whyNow: z.string().max(200).nullable().optional(),
  momentum: TrendMomentum.nullable().optional(),
  angle: z.string().max(200).nullable().optional(),
  hashtags: z.array(z.string().max(80)).max(8).default([]),
  score: z.number().min(0).max(1).nullable().optional(),
});
export type TrendingTopic = z.infer<typeof TrendingTopicSchema>;

export const TrendingTopicsDocSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  industry: z.string().max(200).nullable().optional(),
  generatedAt: z.string(),
  model: z.string().max(80).nullable().optional(),
  groundingUsed: z.boolean().default(false),
  topics: z.array(TrendingTopicSchema).max(12).default([]),
  expiresAt: z.string(),
});
export type TrendingTopicsDoc = z.infer<typeof TrendingTopicsDocSchema>;

export function trendingTopicsDocId(tenantId: string): string {
  return `trend:${encodeURIComponent(tenantId)}`;
}
