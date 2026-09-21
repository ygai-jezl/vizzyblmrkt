import { z } from "zod";
import { ConsentBasis } from "./productConnection";

/**
 * Product user — one end user of a tenant's connected product (e.g. a vizzybl.ai
 * customer), built from the events the product pushes. Lives in the
 * tenant-scoped `product_users` collection (regional DB — end-user PII).
 *
 * The id is `pu_<sha256(connectionId:externalUserId)>` so it is deterministic per
 * connection AND globally unique (connection ids are random), which matters
 * because create() is atomic across every tenant in a regional database.
 *
 * Deleting a user (a `user.deleted` event or an admin erase) clears the PII and
 * leaves a short-lived tombstone (`status: "deleted"`, `ttlAt` ~30 days) so a
 * late retry of an old event can't quietly re-create them.
 */

export const ProductUserStatus = z.enum(["active", "deleted"]);
export type ProductUserStatus = z.infer<typeof ProductUserStatus>;

/** A trait value: flat primitives only (no nested objects). */
export const TraitValueSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
export type TraitValue = z.infer<typeof TraitValueSchema>;

export const ProductUserSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  externalUserId: z.string().max(256),
  email: z.string().nullable().optional(),
  emailNormalized: z.string().nullable().optional(),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  locale: z.string().max(16).nullable().optional(),
  /** Custom traits (≤50 keys). Reserved identity traits live in the fields above. */
  traits: z.record(z.string(), TraitValueSchema).default({}),
  /** Event time of the newest identify applied — older ones don't overwrite. */
  traitsUpdatedAt: z.string().nullable().optional(),
  /** Onboarding step id → when it was first completed. */
  steps: z.record(z.string(), z.object({ doneAt: z.string() })).default({}),
  /** Event name → first/last occurrence + count. */
  milestones: z
    .record(
      z.string(),
      z.object({ firstAt: z.string(), lastAt: z.string(), count: z.number().int().nonnegative() }),
    )
    .default({}),
  consent: z
    .object({
      basis: ConsentBasis,
      /** What the product said, before any free-mail downgrade. */
      assertedBasis: ConsentBasis.optional(),
      source: z.string().max(64).nullable().optional(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** Email category → subscribed, as last reported by the product. */
  emailPreferences: z
    .record(z.string(), z.object({ subscribed: z.boolean(), at: z.string() }))
    .default({}),
  status: ProductUserStatus,
  /** Firestore TTL (a Date) — set only on tombstones. */
  ttlAt: z.unknown().optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductUser = z.infer<typeof ProductUserSchema>;
