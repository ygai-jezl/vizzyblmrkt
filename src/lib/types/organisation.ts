import { z } from "zod";

/**
 * Organisations and plans (PLANS_ENABLED, src/lib/plans). An organisation sits above brands in
 * the control database ((default)) and holds the plan its brands share. The plans themselves are
 * in code (src/lib/plans/catalog.ts); a record only names one.
 *
 * Zod only, no other imports, so src/lib/types/tenant.ts can import it without a cycle.
 *
 * Room kept for later pieces. Nothing below is written yet:
 * - Settings history (piece O): a `settingsVersion` on the organisation, and
 *   organisations/{id}/settings_versions beside it.
 * - Legal entities and founder profiles (Phase 2): subcollections of the organisation, only after
 *   a residency decision, because (default) is the US database (docs/DECISIONS.md ADR-0002).
 * - Connections owned by an organisation (connectors piece 3): an `organisationId` on each
 *   connection record, not a list here.
 * - The Enterprise licence (piece P) belongs to the deployment, not the organisation, and is
 *   never stored here.
 */

/** The five plans, in ladder order. */
export const PLAN_IDS = ["self_hosted", "free", "pro", "ultra", "enterprise"] as const;
export const PlanIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof PlanIdSchema>;

/** What an organisation_changes row records. Rows are only ever added. */
export const ORGANISATION_CHANGE_KINDS = [
  "organisation.created",
  "plan.changed",
  "brand.joined",
  "brand.left",
  "organisation.renamed",
  "owners.changed",
] as const;
export const OrganisationChangeKindSchema = z.enum(ORGANISATION_CHANGE_KINDS);
export type OrganisationChangeKind = z.infer<typeof OrganisationChangeKindSchema>;

/**
 * The most brands one organisation lists. A plan change reads and writes every brand in one
 * transaction, so this stays under Firestore's 500 writes a transaction.
 */
export const MAX_ORGANISATION_BRANDS = 400;
/** The most owners one organisation lists. */
export const MAX_ORGANISATION_OWNERS = 20;
/** The longest organisation name. */
export const MAX_ORGANISATION_NAME = 120;

const Id = z.string().min(1).max(128);

/**
 * organisations/{orgId}. orgId is `org_<first brandId>`, or `org_<tenantId>_<6 characters>` when
 * a brand split back out finds that id taken. It holds plan data and brand links only, never
 * people data.
 */
export const OrganisationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(MAX_ORGANISATION_NAME),
  plan: PlanIdSchema,
  /** When the plan last changed (ISO). */
  planSince: z.string().min(1),
  /** The brands in it. Each brand points back with tenants.organisationId. */
  brandIds: z.array(Id).max(MAX_ORGANISATION_BRANDS),
  /**
   * Firebase UIDs who see the whole organisation on Plan and usage (pseudonymous staff data, like
   * tenant_users.userId). Never inferred from a brand's ownerId: the backfill leaves it empty, a
   * brand made in the app lists its creator, and operators add owners with scripts/set-plan.ts.
   */
  ownerIds: z.array(Id).max(MAX_ORGANISATION_OWNERS).default([]),
  /** "backfill", "selfhost", "seed", or the Firebase UID of the person who made it. */
  createdBy: z.string().min(1).max(160),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Organisation = z.infer<typeof OrganisationSchema>;

/**
 * organisation_changes/{orgId_tenantId_at_kind_rand}, append only. `actor` is a Firebase UID,
 * `script:<label>`, `backfill:<label>`, "seed" or "selfhost": staff data only, never an end user.
 * `from` and `to` hold plan ids, names, or the owners added and removed.
 */
const ChangeValue = z.union([z.string().max(200), z.array(Id).max(MAX_ORGANISATION_OWNERS)]);
export const OrganisationChangeSchema = z.object({
  organisationId: z.string().min(1).max(160),
  kind: OrganisationChangeKindSchema,
  from: ChangeValue.optional(),
  to: ChangeValue.optional(),
  tenantId: Id.optional(),
  actor: z.string().min(1).max(200),
  at: z.string().min(1),
});
export type OrganisationChange = z.infer<typeof OrganisationChangeSchema>;
