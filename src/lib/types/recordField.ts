import { z } from "zod";
import { isCanonicalInstant, jsonBytes } from "@/lib/ontology/events";

/**
 * Fields a brand adds to its people and companies (piece B, AUDIENCE_FIELDS_ENABLED). Each brand
 * has one field list per object, kept as a setting in the regional `record_field_lists` and
 * changed only through commitSettingsChange (src/lib/tenant/settingsLog.ts), so every change is a
 * settings version. Values sit on the record under `fields.<fieldId>`, written only by
 * src/lib/tenant/recordFieldWrites.ts.
 *
 * - A field is archived, never deleted, and its type is fixed once it is made: a type change makes
 *   a new field and archives the old one with `replacedBy`. Values under an archived field stay.
 * - Who made or archived a field is a user id only; names are looked up when shown.
 * - An owner can erase an archived field's values 30 days after it was last archived
 *   (SETTINGS_ERASE_ENABLED): the field keeps its options and gains `erasedAt` and `erasedBy`, and
 *   while the erase runs it is marked `erasingSince` and can't be brought back.
 * - Currency is whole minor units with the code on the field: 1250 means 12.50 USD, and 1250 JPY
 *   means 1250 yen, since the yen has no minor unit (currencyDigits). A date is a calendar day
 *   (YYYY-MM-DD) with no time.
 *
 * Pure: zod and plain data only, so client components can import it.
 */

/** The objects that carry fields in piece B. */
export const RECORD_FIELD_OBJECTS = ["person", "company"] as const;
export type RecordFieldObject = (typeof RECORD_FIELD_OBJECTS)[number];

export function isRecordFieldObject(v: unknown): v is RecordFieldObject {
  return typeof v === "string" && (RECORD_FIELD_OBJECTS as readonly string[]).includes(v);
}

/** The settings subject of each object's field list. */
export const FIELD_LIST_SUBJECT = { person: "fields:person", company: "fields:company" } as const satisfies Record<RecordFieldObject, string>;

/** The twelve types. */
export const FIELD_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "status",
  "email",
  "phone",
  "link",
  "team_member",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Each type in the words the screens use. */
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "text",
  number: "number",
  currency: "currency",
  date: "date",
  checkbox: "checkbox",
  select: "select",
  multi_select: "multi select",
  status: "status",
  email: "email",
  phone: "phone",
  link: "link",
  team_member: "team member",
};

/** The types whose values pick from options. */
export const OPTION_TYPES = ["select", "multi_select", "status"] as const satisfies readonly FieldType[];
export function hasOptions(type: FieldType): boolean {
  return (OPTION_TYPES as readonly string[]).includes(type);
}

/** The types the People list can filter by (one tag per option, or one for a ticked box). */
export const FILTER_TYPES = ["select", "multi_select", "status", "checkbox"] as const satisfies readonly FieldType[];
export function isFilterType(type: FieldType): boolean {
  return (FILTER_TYPES as readonly string[]).includes(type);
}

/**
 * The types Vizzy may read and suggest (AUDIENCE_VIZZY_FIELDS_ENABLED, answer 7 of 20 Nov): values
 * that pick from the brand's own options, a box, a number, an amount or a day. Never email, phone,
 * link or team member values, which can hold who someone is, and text only where an admin let
 * Vizzy read that field (vizzyReadsField).
 */
export const VIZZY_FIELD_TYPES = ["select", "multi_select", "status", "checkbox", "number", "currency", "date"] as const satisfies readonly FieldType[];
export function isVizzyFieldType(type: FieldType): boolean {
  return (VIZZY_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a field can carry "Vizzy can read this field": a text field on People. Email, phone,
 * link and team member fields never can, whatever is set, and nor can a company's fields.
 */
export function canVizzyReadText(field: { type?: unknown; object?: unknown }): boolean {
  return field.type === "text" && field.object === "person";
}

/**
 * The one rule for what Vizzy may read and suggest: a People field in use, either of the seven
 * types, or a text field an admin let Vizzy read while text fields are on (`textFields`, the
 * server's answer for AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED). Never email, phone, link or team member
 * fields, whatever is stored. It checks the type and object itself, since a stored item that
 * doesn't parse is kept as it is.
 */
export function vizzyReadsField(field: { type?: unknown; object?: unknown; archivedAt?: unknown; vizzyReads?: unknown } | null | undefined, textFields: boolean): boolean {
  if (!field || field.object !== "person" || field.archivedAt) return false;
  if (typeof field.type === "string" && isVizzyFieldType(field.type as FieldType)) return true;
  return textFields === true && canVizzyReadText(field) && field.vizzyReads === true;
}

/**
 * The most characters of one text value Vizzy reads, suggests or fills in. A longer value is cut
 * when read, and refused when Vizzy writes it.
 */
export const VIZZY_TEXT_CHARS = 500;

/** A text value cut to at most `max` characters, never splitting a character in two, and whether it was cut. */
export function cutText(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return { text: value.slice(0, end), cut: true };
}

export const FIELD_LIMITS = {
  /** Fields in use on one object. */
  liveFields: 100,
  /** Fields on one object, archived ones included. */
  totalFields: 300,
  /** Options on one field, archived ones included. */
  options: 50,
  labelChars: 60,
  /**
   * The whole list as JSON. Under Firestore's 1 MiB document limit and the settings log's 256 KB
   * snapshot, whatever the counts: the counts alone could reach about 2 MB.
   */
  listBytes: 200 * 1024,
  textChars: 2000,
  multiSelect: 20,
  emailChars: 254,
  phoneChars: 32,
  linkChars: 2000,
} as const;

/** `fld_` and 12 lowercase letters or digits. Fits USER_FIELD_ID, so a dotted path `fields.<id>` is safe. */
export const FIELD_ID = /^fld_[a-z0-9]{12}$/;
/** `opt_` and 8 lowercase letters or digits. */
export const OPTION_ID = /^opt_[a-z0-9]{8}$/;
/** A user id: never an address, never spaces. */
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** ISO 4217: three capital letters. */
export const CURRENCY_CODE = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isFieldId(v: unknown): v is string {
  return typeof v === "string" && FIELD_ID.test(v);
}

const Instant = z.string().refine(isCanonicalInstant, { message: "not a canonical instant" });
const Label = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(FIELD_LIMITS.labelChars));
const UserId = z.string().regex(USER_ID);

export const FieldOptionSchema = z.object({
  id: z.string().regex(OPTION_ID),
  label: Label,
  archivedAt: Instant.nullable().optional(),
});
export type FieldOption = z.infer<typeof FieldOptionSchema>;

/**
 * One field. `key` is its id (the settings log calls an item's id its key). Options are for
 * select, multi select and status, in the order they show (a status's order is its steps).
 * `vizzyReads` is set only on a People text field an admin let Vizzy read; it is left out
 * otherwise, never stored as false.
 */
export const RecordFieldSchema = z
  .object({
    key: z.string().regex(FIELD_ID),
    label: Label,
    type: z.enum(FIELD_TYPES),
    object: z.enum(RECORD_FIELD_OBJECTS),
    options: z.array(FieldOptionSchema).max(FIELD_LIMITS.options).optional(),
    currency: z.string().regex(CURRENCY_CODE).optional(),
    archivedAt: Instant.nullable().optional(),
    archivedBy: UserId.nullable().optional(),
    replacedBy: z.string().regex(FIELD_ID).nullable().optional(),
    vizzyReads: z.literal(true).optional(),
    /** An erase of its values is running (Settings › History, ADR-0021): it stays archived until it ends. */
    erasingSince: Instant.nullable().optional(),
    /** When its values were last erased, and who erased them (a user id). A restore keeps both. */
    erasedAt: Instant.nullable().optional(),
    erasedBy: UserId.nullable().optional(),
    createdAt: Instant,
    createdBy: UserId.nullable(),
  })
  .superRefine((f, c) => {
    if (hasOptions(f.type)) {
      if (!f.options) c.addIssue({ code: "custom", path: ["options"], message: "options_needed" });
      const ids = new Set<string>();
      for (const o of f.options ?? []) {
        if (ids.has(o.id)) c.addIssue({ code: "custom", path: ["options"], message: "option_id_twice" });
        ids.add(o.id);
      }
    } else if (f.options !== undefined) {
      c.addIssue({ code: "custom", path: ["options"], message: "options_only_on_select_multi_select_or_status" });
    }
    if ((f.type === "currency") !== (f.currency !== undefined)) c.addIssue({ code: "custom", path: ["currency"], message: "currency_only_and_always_on_currency" });
    if (f.vizzyReads !== undefined && !canVizzyReadText(f)) c.addIssue({ code: "custom", path: ["vizzyReads"], message: "vizzy_reads_only_on_a_person_text_field" });
  });
export type RecordField = z.infer<typeof RecordFieldSchema>;

/** Why a field list was refused: it would break a cap. */
export type FieldListProblem = "too_many_fields" | "too_many_live_fields" | "too_many_options" | "too_large" | "field_id_twice" | "wrong_object";

/** The problems with a list, or none: the caps, the byte budget and one id per field. */
export function fieldListProblems(items: readonly RecordField[], object?: RecordFieldObject): FieldListProblem[] {
  const out = new Set<FieldListProblem>();
  if (items.length > FIELD_LIMITS.totalFields) out.add("too_many_fields");
  if (items.filter((f) => !f.archivedAt).length > FIELD_LIMITS.liveFields) out.add("too_many_live_fields");
  if (items.some((f) => (f.options?.length ?? 0) > FIELD_LIMITS.options)) out.add("too_many_options");
  if (new Set(items.map((f) => f.key)).size !== items.length) out.add("field_id_twice");
  if (object && items.some((f) => f.object !== object)) out.add("wrong_object");
  if (jsonBytes({ items }) > FIELD_LIMITS.listBytes) out.add("too_large");
  return [...out];
}

/** A whole list, as stored in the setting: its fields, archived ones included, with the caps kept. */
export const FieldListSchema = z
  .object({ items: z.array(RecordFieldSchema) })
  .superRefine((l, c) => {
    for (const p of fieldListProblems(l.items)) c.addIssue({ code: "custom", path: ["items"], message: p });
  });
export type FieldList = { items: RecordField[] };

/** A list as its document holds it in `record_field_lists`, read through forTenant(ctx).recordFieldLists. */
export interface RecordFieldListDoc extends FieldList {
  /** settingsDocId: `ss_` and a hash of the brand and subject. */
  id: string;
  tenantId: string;
  subject: (typeof FIELD_LIST_SUBJECT)[RecordFieldObject];
  rev: number;
  updatedAt: string;
}

// --- Values ------------------------------------------------------------------------------------

/** A stored value: text, a number, a day, a box, an option id or several, or a user id. */
export type FieldValue = string | number | boolean | string[];

/** Values on a record by field id. */
export type FieldValues = Record<string, FieldValue>;

export const FieldValuesSchema = z.record(z.string().regex(FIELD_ID), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

export type ValueCheck = { ok: true; value: FieldValue | null } | { ok: false; reason: string };

function liveOptionIds(field: RecordField): Set<string> {
  return new Set((field.options ?? []).filter((o) => !o.archivedAt).map((o) => o.id));
}

/** Whether a string is a real calendar day, YYYY-MM-DD. */
export function isCalendarDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The option ids a stored value names (a select's or status's one, a multi select's several). */
export function optionIdsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * A value as it would be stored, or why it can't be. null clears. Option values must be live
 * options, or among `held`: options the record already holds, which may stay though they were
 * archived since (a newly chosen option must be live). A team member value is a user id (whether
 * they are on the team is checked by the writer, which knows the members). Pure.
 */
export function checkFieldValue(field: Pick<RecordField, "type" | "options" | "currency">, raw: unknown, held?: ReadonlySet<string>): ValueCheck {
  if (raw === null) return { ok: true, value: null };
  const bad = (reason: string): ValueCheck => ({ ok: false, reason });
  switch (field.type) {
    case "text": {
      if (typeof raw !== "string") return bad("text");
      const v = raw.trim();
      if (!v) return { ok: true, value: null };
      return v.length > FIELD_LIMITS.textChars ? bad("text_too_long") : { ok: true, value: v };
    }
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? { ok: true, value: raw } : bad("number");
    case "currency":
      return typeof raw === "number" && Number.isSafeInteger(raw) ? { ok: true, value: raw } : bad("currency_minor_units");
    case "date":
      return typeof raw === "string" && isCalendarDay(raw) ? { ok: true, value: raw } : bad("date");
    case "checkbox":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad("checkbox");
    case "select":
    case "status": {
      if (typeof raw !== "string") return bad("option");
      return liveOptionIds(field as RecordField).has(raw) || held?.has(raw) ? { ok: true, value: raw } : bad("option");
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return bad("options");
      const ids = [...new Set(raw as string[])];
      if (ids.length > FIELD_LIMITS.multiSelect) return bad("too_many_options");
      const live = liveOptionIds(field as RecordField);
      if (ids.some((id) => !live.has(id) && !held?.has(id))) return bad("option");
      return { ok: true, value: ids.length ? ids : null };
    }
    case "email": {
      if (typeof raw !== "string") return bad("email");
      // The same rule as normalizeEmail (src/lib/waitlist/identifiers.ts): trimmed and lowercased.
      const v = raw.trim().toLowerCase();
      if (!v) return { ok: true, value: null };
      return v.length <= FIELD_LIMITS.emailChars && EMAIL.test(v) ? { ok: true, value: v } : bad("email");
    }
    case "phone": {
      if (typeof raw !== "string") return bad("phone");
      // Trimmed only, as sign-ups keep a phone (src/lib/audience/personSync.ts).
      const v = raw.trim();
      if (!v) return { ok: true, value: null };
      return v.length <= FIELD_LIMITS.phoneChars ? { ok: true, value: v } : bad("phone");
    }
    case "link": {
      if (typeof raw !== "string") return bad("link");
      const v = raw.trim();
      if (!v) return { ok: true, value: null };
      if (v.length > FIELD_LIMITS.linkChars) return bad("link");
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:" ? { ok: true, value: v } : bad("link");
      } catch {
        return bad("link");
      }
    }
    case "team_member":
      return typeof raw === "string" && USER_ID.test(raw) ? { ok: true, value: raw } : bad("team_member");
  }
}

/**
 * How many digits a currency has after the point: 2 for USD, 0 for JPY, 3 for KWD. From the
 * runtime's currency data (Intl), the same in the browser and on the server; 2 for a code it
 * doesn't know.
 */
export function currencyDigits(code: string | null | undefined): number {
  if (!code) return 2;
  try {
    const d = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 4 ? d : 2;
  } catch {
    return 2;
  }
}

/** Whole minor units as the amount people read and type: 1250 is "12.50" in USD and "1250" in JPY. */
export function minorToAmount(minor: number, code: string | null | undefined): string {
  const d = currencyDigits(code);
  return (minor / 10 ** d).toFixed(d);
}

/** An amount typed in the currency's own units as whole minor units: "12.5" is 1250 in USD, "1000" is 1000 in JPY. NaN when it isn't a number. */
export function amountToMinor(amount: string, code: string | null | undefined): number {
  return Math.round(Number(amount) * 10 ** currencyDigits(code));
}

/** Whether two stored values are the same (a multi select compares as a set). */
export function sameFieldValue(a: FieldValue | null | undefined, b: FieldValue | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    const s = new Set(x);
    return y.every((v) => s.has(v));
  }
  return x === y;
}

/** A field's options that are in use, in order. */
export function liveOptions(field: Pick<RecordField, "options">): FieldOption[] {
  return (field.options ?? []).filter((o) => !o.archivedAt);
}

/**
 * The options an editor offers for a value: those in use, then any archived option the value still
 * holds, so it can be seen and taken off. An archived one can't be picked again once it's off.
 */
export function optionsForValue(field: Pick<RecordField, "options">, value: unknown): FieldOption[] {
  const held = new Set(optionIdsOf(value));
  return (field.options ?? []).filter((o) => !o.archivedAt || held.has(o.id));
}

/** An option's label, or null when the field has no such option. */
export function optionLabel(field: Pick<RecordField, "options">, id: string): string | null {
  return field.options?.find((o) => o.id === id)?.label ?? null;
}
