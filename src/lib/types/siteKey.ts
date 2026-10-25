import { z } from "zod";
import { EncryptedBlobSchema } from "./productConnection";

/**
 * A launch's site key (LAUNCH_SITE_SIGNUPS_ENABLED): lets the brand's own server add
 * sign-ups to this one launch with POST /api/v2/signups. Lives in the tenant's
 * regional `launch_site_keys` collection, one per launch, with the launch id as its
 * document id. The control-plane `launch_keys/{keyId}` lookup routes a request to it
 * (src/lib/tenant/launchKeys.ts).
 *
 * The secret is sealed (src/lib/waitlist/siteKeys.ts) and shown to the operator once.
 * A revoked key keeps its record, without secrets, for audit.
 */
export const SiteKeySchema = z.object({
  /** The launch id. */
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  keyId: z.string(),
  status: z.enum(["active", "revoked"]),
  secretEnc: EncryptedBlobSchema.nullable(),
  /** The start of the secret, so an operator can tell secrets apart. */
  secretPrefix: z.string(),
  /** The previous secret during a rotation, valid until prevSecretExpiresAt. */
  prevSecretEnc: EncryptedBlobSchema.nullable().optional(),
  prevSecretExpiresAt: z.string().nullable().optional(),
  /** Where people land after confirming (https). Absent: the "You're subscribed" page. */
  siteConfirmedUrl: z.string().nullable().optional(),
  /** When a call last used the key. Written at most every few minutes. */
  lastUsedAt: z.string().nullable().optional(),
  /** The UTC Monday (YYYY-MM-DD) `weekSignups` counts from. */
  weekStart: z.string().nullable().optional(),
  /** New sign-ups the key added since `weekStart`. */
  weekSignups: z.number().int().min(0).optional(),
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revokedAt: z.string().nullable().optional(),
});
export type SiteKey = z.infer<typeof SiteKeySchema>;
