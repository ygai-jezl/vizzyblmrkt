import { forTenant, setRecordFieldValues, type SetFieldValuesInput, type SetFieldValuesResult, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { FIELD_TYPE_LABEL, optionLabel, type FieldType, type FieldValue, type FieldValues, type RecordField } from "@/lib/types/recordField";

/**
 * Field values on people and companies (AUDIENCE_FIELDS_ENABLED): the way in for routes and,
 * later, Vizzy's confirm. Writes go through the one writer, src/lib/tenant/recordFieldWrites.ts,
 * which checks each change against the field list inside its transaction. This file adds what
 * needs the control plane (who is on the team) and how values read in words.
 */

/** Ids per membership query (Firestore's `in` limit). */
const IN_CHUNK = 30;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Which of these user ids are on this brand's team now. */
export async function currentMembers(ctx: TenantContext, userIds: readonly string[], db?: FirestoreLike): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id) => USER_ID.test(id)))].slice(0, 100);
  const out = new Set<string>();
  const members = forTenant(ctx, db).members;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await members.find({ where: [["userId", "in", ids.slice(i, i + IN_CHUNK)]] });
    for (const r of rows) out.add(r.userId);
  }
  return out;
}

/**
 * Set some of a person's or company's field values. A team member value must be someone on the
 * team now; the strings among the changes are looked up first (the team lives in the control
 * plane, outside the record's transaction).
 */
export async function setFieldValues(
  ctx: TenantContext,
  input: Omit<SetFieldValuesInput, "members">,
  opts: { db?: FirestoreLike } = {},
): Promise<SetFieldValuesResult> {
  const candidates = Object.values(input.changes ?? {}).filter((v): v is string => typeof v === "string" && USER_ID.test(v));
  const members = candidates.length ? await currentMembers(ctx, candidates, opts.db) : new Set<string>();
  return setRecordFieldValues(ctx, { ...input, members }, opts);
}

/** One value with its field, as an export or a screen shows it. */
export interface LabelledValue {
  fieldId: string;
  label: string;
  type: FieldType;
  typeLabel: string;
  /** The field is archived: hidden on screen, kept on the record and in the export. */
  archived: boolean;
  value: FieldValue;
  /** Option labels for a select, multi select or status; the value itself otherwise. */
  text: string;
}

/** A value in words: option labels by id, a box as Yes or No, the rest as stored (a team member stays an id here). */
export function valueText(field: Pick<RecordField, "type" | "options" | "currency">, value: FieldValue): string {
  switch (field.type) {
    case "select":
    case "status":
      return optionLabel(field, String(value)) ?? String(value);
    case "multi_select":
      return (Array.isArray(value) ? value : [value]).map((id) => optionLabel(field, String(id)) ?? String(id)).join(", ");
    case "checkbox":
      return value === true ? "Yes" : "No";
    case "currency":
      return typeof value === "number" ? `${(value / 100).toFixed(2)} ${field.currency ?? ""}`.trim() : String(value);
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/**
 * A record's values with their labels, in the list's order, archived fields marked. Values under
 * an id the list doesn't have are kept, labelled as an unknown field, so an export never drops one.
 */
export function labelledValues(fields: readonly RecordField[], values: FieldValues | null | undefined): LabelledValue[] {
  if (!values) return [];
  const out: LabelledValue[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === null) continue;
    seen.add(f.key);
    out.push({ fieldId: f.key, label: f.label, type: f.type, typeLabel: FIELD_TYPE_LABEL[f.type], archived: !!f.archivedAt, value: v, text: valueText(f, v) });
  }
  for (const [id, v] of Object.entries(values)) {
    if (seen.has(id) || v === undefined || v === null) continue;
    out.push({ fieldId: id, label: "Unknown field", type: "text", typeLabel: FIELD_TYPE_LABEL.text, archived: true, value: v, text: Array.isArray(v) ? v.join(", ") : String(v) });
  }
  return out;
}
