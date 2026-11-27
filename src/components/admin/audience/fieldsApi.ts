import type { FieldListChange, StoredFieldList } from "@/lib/audience/fieldList";
import type { FieldValues, RecordFieldObject } from "@/lib/types/recordField";
import { api } from "../connect/api";

/**
 * The fields screens' calls (AUDIENCE_FIELDS_ENABLED) and every message they show, in plain
 * words. Settings › Data model and the Fields panels on a person and a company share them; the
 * help page (your-audience, #fields) quotes them.
 */

export type { StoredFieldList };
export type Team = Array<{ id: string; name: string }>;

export interface FieldVersionRow {
  rev: number;
  savedAt: string;
  by: string;
  message: string | null;
  source: string;
  restoredFrom: number | null;
  items: Array<{ key: string; label: string; change: string }>;
  moreItems: number;
}

export const FIELD_MESSAGES = {
  fields_changed: "Someone changed the fields while you were editing. Reload to see their change.",
  field_list_full: "This field list is full. Archive fields you no longer use, or use fewer options.",
  invalid_field: "Check the field: a name needs 1 to 60 characters, and a currency field needs a three letter code such as GBP.",
  field_not_found: "That field is no longer there. Reload the page to see the list as it is.",
  option_not_found: "That option is no longer there. Reload the page to see the list as it is.",
  field_erasing: "Its values are being erased. It can be brought back once that is done.",
  unknown_field: "That field is no longer there. Reload the page to see the list as it is.",
  archived_field: "This field was archived while you were editing. Reload the page.",
  invalid_value: "That value doesn't fit this field. Check it and try again.",
  not_on_team: "That person isn't on your team any more. Pick someone who is.",
  record_too_large: "This record can't hold any more. Shorten some long text first.",
  forbidden: "Only admins can change fields.",
  failed: "That didn't save. Try again.",
} as const;

/** The hint beside "Vizzy can read this field" in Data model (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED); the help page quotes it. */
export const VIZZY_READS_HINT = "Only for fields that don't say who someone is or how to reach them.";

/** The plain-word message for an error a fields route answered. */
export function fieldErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string; reason?: string };
  if (d.reason === "not_on_team") return FIELD_MESSAGES.not_on_team;
  return (d.error && (FIELD_MESSAGES as Record<string, string>)[d.error]) || FIELD_MESSAGES.failed;
}

export async function loadFieldLists() {
  return api<{ lists: Record<RecordFieldObject, StoredFieldList>; team: Team }>("/api/admin/audience/fields");
}

export async function changeFieldList(object: RecordFieldObject, baseRev: number, change: FieldListChange) {
  return api<{ list: StoredFieldList; message: string; error?: string }>("/api/admin/audience/fields", {
    method: change.op === "add" ? "POST" : "PATCH",
    body: JSON.stringify({ object, baseRev, change }),
  });
}

export async function loadFieldHistory(object: RecordFieldObject) {
  return api<{ versions: FieldVersionRow[]; nextCursor: number | null }>(`/api/admin/audience/fields/history?object=${object}`);
}

export async function saveFieldValues(object: RecordFieldObject, recordId: string, changes: Record<string, unknown>) {
  const path =
    object === "person"
      ? `/api/admin/audience/everyone/${encodeURIComponent(recordId)}/fields`
      : `/api/admin/crm/companies/${encodeURIComponent(recordId)}/fields`;
  return api<{ values: FieldValues; changed: string[]; error?: string }>(path, { method: "PATCH", body: JSON.stringify({ changes }) });
}
