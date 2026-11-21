import { isFieldId, isFilterType, type FieldValues, type RecordField } from "@/lib/types/recordField";

/**
 * The People list's tags for field values (piece B): what lets it show everyone with one value
 * through the existing `memberOf` index, one array-contains at a time. Pure.
 *
 * - `field:<fieldId>:<optionId>` for a select or status value, and for each option of a multi
 *   select;
 * - `field:<fieldId>:yes` for a ticked checkbox.
 *
 * The field writer keeps them in step with the values in the same transaction; a sync carries
 * them over untouched (isCarriedTag in ./personLinks.ts). Archived fields and options keep their
 * tags with their values, so a restore brings the filter back with nothing to run.
 */

export const FIELD_TAG_PREFIX = "field:";

/** Field tags past this many are dropped, like product groups (MAX_GROUP_TAGS in ./personLinks.ts). */
export const MAX_FIELD_TAGS = 50;

/** The tag for a ticked checkbox. */
export const CHECKED = "yes";

const OPTION_OR_YES = /^(opt_[a-z0-9]{8}|yes)$/;

export function fieldTag(fieldId: string, value: string): string {
  return `${FIELD_TAG_PREFIX}${fieldId}:${value}`;
}

export function isFieldTag(tag: string): boolean {
  return typeof tag === "string" && tag.startsWith(FIELD_TAG_PREFIX);
}

/** A field tag's parts, or null for anything that isn't one the writer makes. */
export function parseFieldTag(tag: string): { fieldId: string; value: string } | null {
  if (!isFieldTag(tag)) return null;
  const [fieldId, value, ...rest] = tag.slice(FIELD_TAG_PREFIX.length).split(":");
  if (rest.length || !fieldId || !value || !isFieldId(fieldId) || !OPTION_OR_YES.test(value)) return null;
  return { fieldId, value };
}

/**
 * The tags for a record's values, sorted, at most MAX_FIELD_TAGS, with how many were dropped.
 * Only filterable types make tags; values of fields the list doesn't have make none.
 */
export function fieldTagsFor(fields: readonly Pick<RecordField, "key" | "type">[], values: FieldValues | null | undefined): { tags: string[]; dropped: number } {
  const tags = new Set<string>();
  for (const f of fields) {
    if (!isFilterType(f.type)) continue;
    const v = values?.[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === "checkbox") {
      if (v === true) tags.add(fieldTag(f.key, CHECKED));
    } else if (f.type === "multi_select") {
      if (Array.isArray(v)) for (const id of v) if (typeof id === "string") tags.add(fieldTag(f.key, id));
    } else if (typeof v === "string") {
      tags.add(fieldTag(f.key, v));
    }
  }
  const all = [...tags].sort();
  return { tags: all.slice(0, MAX_FIELD_TAGS), dropped: Math.max(0, all.length - MAX_FIELD_TAGS) };
}

/** The tags with their field tags replaced by `fieldTags`: every other tag kept, sorted, each once. */
export function withFieldTags(current: readonly string[] | null | undefined, fieldTags: readonly string[]): string[] {
  return [...new Set([...(current ?? []).filter((t) => !isFieldTag(t)), ...fieldTags])].sort();
}

/** Whether two sets of field tags are the same, whatever their order. */
export function sameFieldTags(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a.filter(isFieldTag));
  const y = new Set(b.filter(isFieldTag));
  return x.size === y.size && [...x].every((t) => y.has(t));
}

/**
 * The tags a record should have for its values, when they differ from what it has: the backfill's
 * plan (scripts/backfill-field-tags.ts). Null when the record's field tags are already right.
 */
export function fieldTagRepair(
  fields: readonly Pick<RecordField, "key" | "type">[],
  values: FieldValues | null | undefined,
  memberOf: readonly string[] | null | undefined,
): { memberOf: string[]; dropped: number } | null {
  const want = fieldTagsFor(fields, values);
  if (sameFieldTags(memberOf ?? [], want.tags)) return null;
  return { memberOf: withFieldTags(memberOf, want.tags), dropped: want.dropped };
}
