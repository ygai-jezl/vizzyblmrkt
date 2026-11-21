import { z } from "zod";
import { commitSettingsChange, readSetting, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { EventActor } from "@/lib/ontology/events";
import { describeItemChanges } from "@/lib/settings/archive";
import { getSettingsVersion, planRestore } from "@/lib/settings/history";
import {
  FIELD_LIMITS,
  FIELD_LIST_SUBJECT,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  canVizzyReadText,
  fieldListProblems,
  FieldListSchema,
  hasOptions,
  RecordFieldSchema,
  CURRENCY_CODE,
  type FieldList,
  type FieldOption,
  type FieldType,
  type RecordField,
  type RecordFieldObject,
} from "@/lib/types/recordField";

/**
 * A brand's field lists, one for People and one for Companies (AUDIENCE_FIELDS_ENABLED). Each is
 * a setting in the regional `record_field_lists`, saved only through commitSettingsChange, so the
 * list and the version that records its change commit together and every change is kept.
 *
 * - A save names the rev it was made from; a stale one answers `fields_changed` (409).
 * - Fields and options are archived, never deleted, and a field's type is fixed once it is made:
 *   changing it makes a new field with the same label and archives the old one with `replacedBy`.
 *   Values under an archived field stay on each record and come back with a restore.
 * - A list that would break a cap answers `field_list_full` (400).
 * - "Vizzy can read this field" (`vizzyReads`) is only for a People text field in use, set by an
 *   admin with the `vizzy_reads` change or when adding one. A restore can turn it off, never on.
 */

export type FieldListChange =
  | { op: "add"; label: string; type: FieldType; options?: string[]; currency?: string; vizzyReads?: boolean }
  | { op: "rename"; key: string; label: string }
  | { op: "reorder"; keys: string[] }
  | { op: "add_option"; key: string; label: string }
  | { op: "rename_option"; key: string; optionId: string; label: string }
  | { op: "archive_option"; key: string; optionId: string }
  | { op: "restore_option"; key: string; optionId: string }
  | { op: "archive"; key: string }
  | { op: "restore"; key: string }
  | { op: "change_type"; key: string; type: FieldType; options?: string[]; currency?: string }
  | { op: "vizzy_reads"; key: string; on: boolean };

export type FieldListError = "fields_changed" | "field_list_full" | "field_not_found" | "option_not_found" | "invalid_field";

export interface StoredFieldList extends FieldList {
  object: RecordFieldObject;
  /** The rev of the last save, 0 for never. A save names it. */
  rev: number;
  updatedAt: string | null;
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `n` random lowercase letters and digits. */
function randomPart(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALNUM[b % ALNUM.length]).join("");
}

export const newFieldId = (): string => `fld_${randomPart(12)}`;
export const newOptionId = (): string => `opt_${randomPart(8)}`;

/** The list as stored, parsed, or an empty one at rev 0. A stored item that doesn't parse is kept as it is. */
export async function readFieldList(ctx: TenantContext, object: RecordFieldObject, db?: FirestoreLike): Promise<StoredFieldList> {
  const stored = await readSetting<FieldList>(ctx, FIELD_LIST_SUBJECT[object], db);
  return { object, items: stored?.value.items ?? [], rev: stored?.rev ?? 0, updatedAt: stored?.updatedAt ?? null };
}

export interface ApplyOptions {
  nowIso: string;
  /** The member making the change, by user id: stamped as createdBy or archivedBy. */
  userId: string | null;
  newFieldId?: () => string;
  newOptionId?: () => string;
}

type Applied = { ok: true; items: RecordField[]; message: string } | { ok: false; error: FieldListError };

function trimmedLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const v = label.trim();
  return v && v.length <= FIELD_LIMITS.labelChars ? v : null;
}

function optionsFrom(labels: string[] | undefined, makeId: () => string): FieldOption[] | null {
  const out: FieldOption[] = [];
  for (const raw of labels ?? []) {
    const label = trimmedLabel(raw);
    if (!label) return null;
    if (out.some((o) => o.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ id: makeId(), label });
  }
  return out;
}

/**
 * A new field of a type, with its options or currency, or null when they don't fit it. `vizzyReads`
 * is left out unless it is asked for, and only a People text field can have it.
 */
function makeField(
  object: RecordFieldObject,
  label: string,
  type: FieldType,
  extra: { options?: string[]; currency?: string; vizzyReads?: boolean },
  opts: ApplyOptions,
): RecordField | null {
  if (!(FIELD_TYPES as readonly string[]).includes(type)) return null;
  const options = hasOptions(type) ? optionsFrom(extra.options, opts.newOptionId ?? newOptionId) : undefined;
  if (options === null) return null;
  const currency = type === "currency" ? (extra.currency ?? "").trim().toUpperCase() : undefined;
  if (currency !== undefined && !CURRENCY_CODE.test(currency)) return null;
  if (extra.vizzyReads === true && !canVizzyReadText({ type, object })) return null;
  const field: RecordField = {
    key: (opts.newFieldId ?? newFieldId)(),
    label,
    type,
    object,
    ...(options !== undefined ? { options } : {}),
    ...(currency !== undefined ? { currency } : {}),
    archivedAt: null,
    archivedBy: null,
    replacedBy: null,
    ...(extra.vizzyReads === true ? { vizzyReads: true as const } : {}),
    createdAt: opts.nowIso,
    createdBy: opts.userId,
  };
  return RecordFieldSchema.safeParse(field).success ? field : null;
}

/**
 * One change to a list, purely: the list after it and a plain-word message, or why it can't be
 * made. Nothing is ever removed.
 */
export function applyFieldListChange(object: RecordFieldObject, items: readonly RecordField[], change: FieldListChange, opts: ApplyOptions): Applied {
  const find = (key: string) => items.findIndex((f) => f.key === key);
  const replace = (i: number, next: RecordField): RecordField[] => items.map((f, j) => (j === i ? next : f));
  const done = (next: RecordField[], message: string): Applied => {
    if (fieldListProblems(next, object).length) return { ok: false, error: "field_list_full" };
    return { ok: true, items: next, message: message.slice(0, 200) };
  };
  switch (change.op) {
    case "add": {
      const label = trimmedLabel(change.label);
      if (!label) return { ok: false, error: "invalid_field" };
      const field = makeField(object, label, change.type, change, opts);
      if (!field) return { ok: false, error: "invalid_field" };
      return done([...items, field], field.vizzyReads ? `Added ‘${label}’ and let Vizzy read it` : `Added ‘${label}’`);
    }
    case "rename": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const label = trimmedLabel(change.label);
      if (!label) return { ok: false, error: "invalid_field" };
      const was = items[i]!.label;
      if (was === label) return done([...items], `Renamed ‘${was}’`);
      return done(replace(i, { ...items[i]!, label }), `Renamed ‘${was}’ to ‘${label}’`);
    }
    case "reorder": {
      const keys = change.keys;
      if (!Array.isArray(keys) || keys.length !== items.length || new Set(keys).size !== keys.length || keys.some((k) => find(k) < 0)) {
        return { ok: false, error: "invalid_field" };
      }
      return done(
        keys.map((k) => items[find(k)]!),
        "Changed the order of the fields",
      );
    }
    case "add_option":
    case "rename_option":
    case "archive_option":
    case "restore_option": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const f = items[i]!;
      if (!hasOptions(f.type)) return { ok: false, error: "invalid_field" };
      const options = f.options ?? [];
      if (change.op === "add_option") {
        const label = trimmedLabel(change.label);
        if (!label) return { ok: false, error: "invalid_field" };
        if (options.some((o) => !o.archivedAt && o.label.toLowerCase() === label.toLowerCase())) return done([...items], `Added option ‘${label}’ to ‘${f.label}’`);
        return done(replace(i, { ...f, options: [...options, { id: (opts.newOptionId ?? newOptionId)(), label }] }), `Added option ‘${label}’ to ‘${f.label}’`);
      }
      const k = options.findIndex((o) => o.id === change.optionId);
      if (k < 0) return { ok: false, error: "option_not_found" };
      const o = options[k]!;
      const withOption = (next: FieldOption) => replace(i, { ...f, options: options.map((x, j) => (j === k ? next : x)) });
      if (change.op === "rename_option") {
        const label = trimmedLabel(change.label);
        if (!label) return { ok: false, error: "invalid_field" };
        return done(withOption({ ...o, label }), `Renamed option ‘${o.label}’ to ‘${label}’ in ‘${f.label}’`);
      }
      if (change.op === "archive_option") return done(withOption({ ...o, archivedAt: o.archivedAt || opts.nowIso }), `Archived option ‘${o.label}’ in ‘${f.label}’`);
      return done(withOption({ ...o, archivedAt: null }), `Restored option ‘${o.label}’ in ‘${f.label}’`);
    }
    case "archive": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const f = items[i]!;
      if (f.archivedAt) return done([...items], `Archived ‘${f.label}’`);
      return done(replace(i, { ...f, archivedAt: opts.nowIso, archivedBy: opts.userId }), `Archived ‘${f.label}’`);
    }
    case "restore": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const f = items[i]!;
      // Bring back never turns reading on: an admin ticks it again if Vizzy should read it.
      return done(replace(i, keepReading(f, { ...f, archivedAt: null, archivedBy: null, replacedBy: null })), `Restored ‘${f.label}’`);
    }
    case "change_type": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const old = items[i]!;
      if (old.archivedAt) return { ok: false, error: "invalid_field" };
      const field = makeField(object, old.label, change.type, change, opts);
      if (!field || field.type === old.type) return { ok: false, error: "invalid_field" };
      const archived = { ...old, archivedAt: opts.nowIso, archivedBy: opts.userId, replacedBy: field.key };
      // The new field takes the old one's place in the order; the archived one follows it.
      const next = [...items.slice(0, i), field, archived, ...items.slice(i + 1)];
      return done(next, `Changed ‘${old.label}’ to ${FIELD_TYPE_LABEL[field.type]}`);
    }
    case "vizzy_reads": {
      const i = find(change.key);
      if (i < 0) return { ok: false, error: "field_not_found" };
      const f = items[i]!;
      if (f.archivedAt || !canVizzyReadText(f) || typeof change.on !== "boolean") return { ok: false, error: "invalid_field" };
      const message = change.on ? `Let Vizzy read ‘${f.label}’` : `Stopped Vizzy reading ‘${f.label}’`;
      // Already so: nothing changes, and no version is written.
      if ((f.vizzyReads === true) === change.on) return done([...items], message);
      const rest = withoutReading(f);
      return done(replace(i, change.on ? { ...rest, vizzyReads: true } : rest), message);
    }
  }
}

/** Whether Vizzy reads a field as it stands: a text field in use that an admin let it read. */
function reading(f: Pick<RecordField, "archivedAt"> & { vizzyReads?: unknown }): boolean {
  return !f.archivedAt && f.vizzyReads === true;
}

/** A field with "Vizzy can read this field" left out. */
function withoutReading(f: RecordField): RecordField {
  const { vizzyReads: _off, ...rest } = f;
  return rest;
}

/**
 * A field after a restore or Bring back, `next`, with "Vizzy can read this field" kept only where
 * it doesn't turn reading on: Vizzy reads `next` only if it read `now` already, and an archived
 * field keeps the mark only if `now` had it. An older version or Bring back can turn reading off,
 * never on.
 */
function keepReading(now: RecordField | undefined, next: RecordField): RecordField {
  if (next.vizzyReads === undefined) return next;
  if (now?.vizzyReads === true && (reading(now) || !!next.archivedAt)) return next;
  return withoutReading(next);
}

export type FieldListSave =
  | { ok: true; list: StoredFieldList; message: string }
  | { ok: false; error: FieldListError; list?: StoredFieldList };

/** The member's user id from who made the change, for createdBy and archivedBy. */
function userIdOf(by: EventActor): string | null {
  return by.type === "member" && by.id ? by.id : null;
}

/**
 * Make one change to a list from the rev the page shows, as a new settings version. Answers
 * `fields_changed` with the list as it is now when someone saved in between.
 */
export async function saveFieldListChange(
  ctx: TenantContext,
  object: RecordFieldObject,
  input: { baseRev: number; change: FieldListChange; by: EventActor; message?: string | null; nowIso?: string; newFieldId?: () => string; newOptionId?: () => string },
  db?: FirestoreLike,
): Promise<FieldListSave> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const current = await readFieldList(ctx, object, db);
  if (current.rev !== input.baseRev) return { ok: false, error: "fields_changed", list: current };
  const applied = applyFieldListChange(object, current.items, input.change, {
    nowIso,
    userId: userIdOf(input.by),
    newFieldId: input.newFieldId,
    newOptionId: input.newOptionId,
  });
  if (!applied.ok) return applied;
  // Nothing changed (the same name, an option already there): no version.
  if (JSON.stringify(applied.items) === JSON.stringify(current.items)) return { ok: true, list: current, message: applied.message };
  if (!FieldListSchema.safeParse({ items: applied.items }).success) return { ok: false, error: "invalid_field" };
  const r = await commitSettingsChange<FieldList>(
    ctx,
    {
      subject: FIELD_LIST_SUBJECT[object],
      baseRev: input.baseRev,
      value: { items: applied.items },
      by: input.by,
      source: "editor",
      message: input.message?.trim() || applied.message,
      nowIso,
    },
    db,
  );
  if (!r.ok) return { ok: false, error: "fields_changed", list: { object, items: r.current?.value.items ?? [], rev: r.current?.rev ?? 0, updatedAt: r.current?.updatedAt ?? null } };
  return { ok: true, list: { object, items: applied.items, rev: r.rev, updatedAt: nowIso }, message: applied.message };
}

/**
 * Bring back an earlier version of a list as a new one, from the rev the page shows. Fields and
 * options the earlier version didn't have are archived, never removed, so values and filters that
 * name them keep their label. Answers `field_not_found` when there is no such version, and
 * `field_list_full` when the result would break a cap.
 */
export async function restoreFieldListVersion(
  ctx: TenantContext,
  object: RecordFieldObject,
  input: { rev: number; baseRev: number; by: EventActor; nowIso?: string },
  db?: FirestoreLike,
): Promise<FieldListSave> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const subject = FIELD_LIST_SUBJECT[object];
  const [current, target] = await Promise.all([readFieldList(ctx, object, db), getSettingsVersion(ctx, subject, input.rev, db)]);
  if (current.rev !== input.baseRev) return { ok: false, error: "fields_changed", list: current };
  if (!target) return { ok: false, error: "field_not_found" };
  const plan = planRestore(current.items, target.snapshot.items as unknown as RecordField[], nowIso);
  // Fields the restore archives say who archived them, as an archive from the editor does.
  const archivedBy = input.by.type === "member" ? input.by.id : null;
  const archived = new Set(plan.archived.map((f) => f.key));
  const now = new Map(current.items.map((f) => [f.key, f]));
  const items = plan.items.map((f) => {
    const next = archived.has(f.key) ? { ...f, archivedBy } : f;
    // A restore never turns reading on; an item the list doesn't hold now comes back without it.
    return keepReading(now.get(f.key), next);
  });
  if (fieldListProblems(items, object).length) return { ok: false, error: "field_list_full" };
  if (!FieldListSchema.safeParse({ items }).success) return { ok: false, error: "invalid_field" };
  const message = `Restored version ${input.rev}`;
  const r = await commitSettingsChange<FieldList>(
    ctx,
    {
      subject,
      baseRev: input.baseRev,
      value: { items },
      by: input.by,
      source: "restore",
      restoredFrom: input.rev,
      message,
      items: describeItemChanges(current.items, items),
      nowIso,
    },
    db,
  );
  if (!r.ok) return { ok: false, error: "fields_changed", list: { object, items: r.current?.value.items ?? [], rev: r.current?.rev ?? 0, updatedAt: r.current?.updatedAt ?? null } };
  return { ok: true, list: { object, items, rev: r.rev, updatedAt: nowIso }, message };
}

// --- Requests ----------------------------------------------------------------------------------

const KeyIn = z.string().regex(/^fld_[a-z0-9]{12}$/);
const OptionIn = z.string().regex(/^opt_[a-z0-9]{8}$/);
const LabelIn = z.string().max(200);
const OptionLabels = z.array(LabelIn).max(FIELD_LIMITS.options).optional();
const TypeIn = z.enum(FIELD_TYPES);
const CurrencyIn = z.string().max(3).optional();

/** One change as a request carries it: checked for shape here, and against the list when applied. */
export const FieldListChangeSchema: z.ZodType<FieldListChange> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), label: LabelIn, type: TypeIn, options: OptionLabels, currency: CurrencyIn, vizzyReads: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("rename"), key: KeyIn, label: LabelIn }).strict(),
  z.object({ op: z.literal("reorder"), keys: z.array(KeyIn).max(FIELD_LIMITS.totalFields) }).strict(),
  z.object({ op: z.literal("add_option"), key: KeyIn, label: LabelIn }).strict(),
  z.object({ op: z.literal("rename_option"), key: KeyIn, optionId: OptionIn, label: LabelIn }).strict(),
  z.object({ op: z.literal("archive_option"), key: KeyIn, optionId: OptionIn }).strict(),
  z.object({ op: z.literal("restore_option"), key: KeyIn, optionId: OptionIn }).strict(),
  z.object({ op: z.literal("archive"), key: KeyIn }).strict(),
  z.object({ op: z.literal("restore"), key: KeyIn }).strict(),
  z.object({ op: z.literal("change_type"), key: KeyIn, type: TypeIn, options: OptionLabels, currency: CurrencyIn }).strict(),
  z.object({ op: z.literal("vizzy_reads"), key: KeyIn, on: z.boolean() }).strict(),
]);

/** Each error's HTTP status: a stale rev is a conflict, a missing field or option is not found, the rest are bad requests. */
export const FIELD_LIST_STATUS: Record<FieldListError, number> = {
  fields_changed: 409,
  field_list_full: 400,
  invalid_field: 400,
  field_not_found: 404,
  option_not_found: 404,
};
