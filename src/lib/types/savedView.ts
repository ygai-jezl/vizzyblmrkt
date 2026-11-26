import { z } from "zod";
import { isCanonicalInstant, jsonBytes } from "@/lib/ontology/events";
import { ViewDefinitionSchema, type ViewDefinition } from "@/lib/views/types";

/**
 * Saved views on People (piece C, CRM_VIEWS_ENABLED). Two kinds, by who can use them:
 *
 * - **Team views** (Everyone on the team) are a brand setting: the settings subject `views:person`,
 *   one list per brand kept in the regional `saved_views` and saved only through
 *   commitSettingsChange, so every save is a settings version. Admins save, change, archive and
 *   bring them back; a view is archived, never removed.
 * - **Only me views** belong to one team member: one document per brand and member in the regional
 *   `member_views` (src/lib/tenant/memberViews.ts), not logged, deleted for real.
 *
 * A saved view never holds typed words (decision 3), so neither kind holds anyone's personal data:
 * filters name options, numbers, amounts, days, yes or no, empty, and team members by user id.
 * Who made or changed a view is a user id only.
 *
 * Pure: zod and plain data only, so client components can import it.
 */

export const SAVED_VIEW_LIMITS = {
  /** Team views in use on one brand. */
  teamInUse: 50,
  /** Team views on one brand, archived ones included. */
  teamTotal: 200,
  /** The team list as JSON, checked in bytes (as FIELD_LIMITS.listBytes): under the settings log's 256 KB snapshot. */
  listBytes: 200 * 1024,
  /** One view as JSON. */
  viewBytes: 2 * 1024,
  /** Only me views one member keeps on one brand. */
  mine: 50,
  nameChars: 60,
} as const;

/** `viw_` and 12 lowercase letters or digits. */
export const VIEW_ID = /^viw_[a-z0-9]{12}$/;

export function isViewId(v: unknown): v is string {
  return typeof v === "string" && VIEW_ID.test(v);
}

export const VIEW_SCOPES = ["team", "me"] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number];

const Instant = z.string().refine(isCanonicalInstant, { message: "not a canonical instant" });
const UserId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const ViewNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(SAVED_VIEW_LIMITS.nameChars));

/**
 * A team view, as an item of the `views:person` setting. `key` is its id and `label` its name, as
 * the settings log names an item's. `version` goes up with each change, so a save made from an
 * older copy of the view is refused instead of undoing someone's change.
 */
export interface SavedView {
  key: string;
  label: string;
  definition: ViewDefinition;
  version: number;
  createdAt: string;
  createdBy: string | null;
  changedAt: string;
  changedBy: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  replacedBy?: string | null;
}

export const SavedViewSchema = z
  .object({
    key: z.string().regex(VIEW_ID),
    label: ViewNameSchema,
    definition: ViewDefinitionSchema,
    version: z.number().int().min(1),
    createdAt: Instant,
    createdBy: UserId.nullable(),
    changedAt: Instant,
    changedBy: UserId.nullable(),
    archivedAt: Instant.nullable().optional(),
    archivedBy: UserId.nullable().optional(),
    replacedBy: z.string().nullable().optional(),
  })
  .strict() as unknown as z.ZodType<SavedView>;

/** The team's list as the setting holds it. */
export interface TeamViewList {
  items: SavedView[];
}

/** An Only me view: no archive, no history. */
export interface MyView {
  key: string;
  label: string;
  definition: ViewDefinition;
  version: number;
  createdAt: string;
  changedAt: string;
}

export const MyViewSchema = z
  .object({
    key: z.string().regex(VIEW_ID),
    label: ViewNameSchema,
    definition: ViewDefinitionSchema,
    version: z.number().int().min(1),
    createdAt: Instant,
    changedAt: Instant,
  })
  .strict() as unknown as z.ZodType<MyView>;

/** One member's Only me views on one brand, as `member_views` holds them (src/lib/tenant/memberViews.ts). */
export interface MemberViewsDoc {
  /** `mv_` and a hash of the brand and the member's user id. */
  id: string;
  tenantId: string;
  userId: string;
  rev: number;
  views: MyView[];
  updatedAt: string;
}

/** Why a team list can't be saved: one of its caps. */
export type TeamListProblem = "too_many_in_use" | "too_many" | "too_large" | "view_too_large" | "key_twice";

/** The caps a team list breaks, or none. */
export function teamListProblems(items: readonly SavedView[]): TeamListProblem[] {
  const out = new Set<TeamListProblem>();
  if (items.filter((v) => !v.archivedAt).length > SAVED_VIEW_LIMITS.teamInUse) out.add("too_many_in_use");
  if (items.length > SAVED_VIEW_LIMITS.teamTotal) out.add("too_many");
  if (items.some((v) => jsonBytes(v) > SAVED_VIEW_LIMITS.viewBytes)) out.add("view_too_large");
  if (new Set(items.map((v) => v.key)).size !== items.length) out.add("key_twice");
  if (jsonBytes({ items }) > SAVED_VIEW_LIMITS.listBytes) out.add("too_large");
  return [...out];
}
