import { z } from "zod";

/**
 * Email suppression — a TENANT-WIDE opt-out record. One row per suppressed
 * address; while present, NO marketing email (journey, broadcast, or any future
 * campaign) may be sent to it. Lives in the tenant-scoped `email_suppressions`
 * collection (regional DB — an email address is marketing PII).
 *
 * The document id is deterministic per (tenant, email) — `sup_<sha256(tenantId\n
 * normalizedEmail)>` — so a repeat unsubscribe / webhook replay collapses to a
 * single row (atomic create rejects the duplicate) and two tenants sharing a
 * region can't collide on the same address. See lib/email/suppression.ts.
 */
export const EmailSuppressionReason = z.enum([
  "unsubscribe",
  "spam",
  "hard_bounce",
]);
export type EmailSuppressionReason = z.infer<typeof EmailSuppressionReason>;

export const EmailSuppressionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Lowercased/trimmed address (the suppression key). */
  normalizedEmail: z.string(),
  /** The address as last seen (for display/audit). */
  email: z.string(),
  reason: EmailSuppressionReason,
  /** Where the opt-out came from (footer link, one-click header, a webhook). */
  source: z.string(),
  /** The campaign/signup that triggered it, when known (audit only). */
  campaignId: z.string().nullable().optional(),
  signupId: z.string().nullable().optional(),
  /**
   * `all` (the default, and every legacy row) stops ALL marketing email to the
   * address. `category` stops only lifecycle email in `category` (e.g. a
   * one-click "stop onboarding tips"); its id is `supc_…`, so it never collides
   * with — or satisfies — the tenant-wide `sup_…` row.
   */
  scope: z.enum(["all", "category"]).default("all"),
  category: z.string().nullable().optional(),
  /** Lifecycle recipient (a connected product's user), when known. */
  connectionId: z.string().nullable().optional(),
  recipientId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type EmailSuppression = z.infer<typeof EmailSuppressionSchema>;
