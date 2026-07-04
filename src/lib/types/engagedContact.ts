import { z } from "zod";

/**
 * A social profile that ENGAGED with our content (replied/mentioned/quoted/DM'd a
 * connected account). Kept in its OWN tenant-scoped `social_engaged` collection —
 * NOT in `contacts` — so scraped social identities never pollute the email-consented
 * CRM Contacts tab, its search, or its dedupe space. Keyed by platform+userId.
 *
 * handle/name come free from the engagement event; bio/location/followers/following
 * are filled by a later profile-lookup enrichment (null until then).
 */
export const EngagedContactSchema = z.object({
  /** = deterministicContactId(tenantId, `engaged:{platform}:{userId}`). */
  id: z.string(),
  tenantId: z.string(),
  platform: z.enum(["x", "instagram", "linkedin"]),
  userId: z.string(),
  handle: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  bio: z.string().max(1000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  followers: z.number().int().nonnegative().nullable().optional(),
  following: z.number().int().nonnegative().nullable().optional(),
  /** How many distinct engagement events we've attributed to this person. */
  engagementCount: z.number().int().nonnegative().default(0),
  /** Lowercased handle/name fragments for array-contains search. */
  searchTokens: z.array(z.string()).default([]),
  firstEngagedAt: z.string(),
  lastEngagedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EngagedContact = z.infer<typeof EngagedContactSchema>;
