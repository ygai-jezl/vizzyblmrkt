import { z } from "zod";

/**
 * Shared email-authoring shapes used by Broadcasts (one-off sends) and Journey
 * email nodes (drip steps). Kept separate so both reuse the exact same content +
 * agent-provenance schema.
 */

/** Marks who authored a block of content — the Agent Presence Token reads this. */
export const AgentMetaSchema = z.object({
  source: z.enum(["agent3", "human"]),
  /** Which generated variant was applied (if any). */
  variantId: z.string().optional(),
  /** ISO timestamp of the last agent edit. */
  at: z.string().optional(),
});
export type AgentMeta = z.infer<typeof AgentMetaSchema>;

/**
 * The composable email content. `body` may contain {{merge_vars}} (see
 * src/lib/email/mergeVars.ts) — they are rendered per-recipient (journey) or
 * translated to MailChimp merge tags (broadcast) by Agent 4 at delivery.
 */
export const EmailContentSchema = z.object({
  subject: z.string(),
  body: z.string(),
  heroImageUrl: z.string().nullable().optional(),
  agentMeta: AgentMetaSchema.optional(),
});
export type EmailContent = z.infer<typeof EmailContentSchema>;
