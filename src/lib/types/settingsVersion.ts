import { z } from "zod";
import { isCanonicalInstant, jsonBytes } from "@/lib/ontology/events";
import { EventActorSchema } from "./agentAction";

/**
 * The settings log (piece O part 1): every change to how a brand works is kept as a version in
 * the brand's regional `settings_versions`, with who, what and why. A restore is a new version on
 * top, and nothing is ever pruned or changed. Written only by commitSettingsChange in
 * src/lib/tenant/settingsLog.ts, in the same transaction as the setting itself; read through
 * forTenant(ctx).settingsVersions and src/lib/settings/history.ts.
 *
 * Versions hold settings only (item keys, labels and options), never a person's values. `by` holds
 * ids only: a team member's user id, an agent action id or a job name. Names are looked up when
 * shown, and someone no longer on the team shows as "Former team member".
 *
 * Pure: zod and plain data only, so client components can import it.
 */

/**
 * What a setting is about. Piece B's field lists are the first; later pieces add their own.
 * `connections:shared` (Connectors 3) is the parts a brand's organisation gives it, one item each.
 */
export const SETTINGS_SUBJECTS = ["fields:person", "fields:company", "connections:shared"] as const;
export type SettingsSubject = (typeof SETTINGS_SUBJECTS)[number];

export function isSettingsSubject(v: unknown): v is SettingsSubject {
  return typeof v === "string" && (SETTINGS_SUBJECTS as readonly string[]).includes(v);
}

/** How a version came about: saved in the app, a restore, an agent's suggestion confirmed, an import, or what was there before history. */
export const SETTINGS_SOURCES = ["editor", "restore", "agent", "import", "before_history"] as const;
export type SettingsSource = (typeof SETTINGS_SOURCES)[number];

/** What happened to one item. There is no "removed": items are archived, never deleted. */
export const SETTINGS_ITEM_CHANGES = ["added", "changed", "archived", "restored"] as const;
export type SettingsItemChange = (typeof SETTINGS_ITEM_CHANGES)[number];

export const SETTINGS_LIMITS = {
  /** Items listed on one version; the rest are counted in moreItems. */
  items: 50,
  /** The items' before and after together, so one version stays well under Firestore's 1 MiB. */
  itemsBytes: 256 * 1024,
  /** The whole setting after the change. Callers keep their setting under it (fields: 200 KB). */
  snapshotBytes: 256 * 1024,
  messageChars: 200,
  keyChars: 200,
  labelChars: 200,
} as const;

/**
 * One item of a setting, such as a field: a stable key, the label people read, and when it was
 * archived. A setting never loses an item; changing what an item is makes a new one and archives
 * the old with `replacedBy` (src/lib/settings/archive.ts).
 */
export interface SettingsItem {
  key: string;
  label: string;
  archivedAt?: string | null;
  replacedBy?: string | null;
}

/** A setting: a list of items, kept whole. */
export interface SettingsList<I extends SettingsItem = SettingsItem> {
  items: I[];
}

/** One line of a version: which item, what happened, and the item before and after. */
export interface SettingsVersionItem {
  key: string;
  label: string;
  change: SettingsItemChange;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type SettingsVersionState = "draft" | "live";

export interface SettingsVersion {
  /** `ss_<40 hex>_r000012`: the brand and subject, then the rev (settingsVersionId). */
  id: string;
  tenantId: string;
  subject: SettingsSubject;
  /** The setting's rev once this version was saved: 1 for the first save. */
  rev: number;
  /** Only "live" is written today; "draft" is kept for piece O's draft flow. */
  state: SettingsVersionState;
  savedAt: string;
  /** Who or what saved it, by id only. */
  by: z.infer<typeof EventActorSchema>;
  message: string | null;
  source: SettingsSource;
  /** For a restore: the rev it brought back. */
  restoredFrom: number | null;
  items: SettingsVersionItem[];
  /** Items left off `items` by the caps. */
  moreItems: number;
  /** The whole setting after the change: its items with all their own properties. */
  snapshot: SettingsList<SettingsItem & Record<string, unknown>>;
}

const Key = z.string().min(1).max(SETTINGS_LIMITS.keyChars);
const Label = z.string().max(SETTINGS_LIMITS.labelChars);
const ItemState = z.record(z.string(), z.unknown()).nullable();

export const SettingsItemSchema = z
  .object({
    key: Key,
    label: Label,
    archivedAt: z.string().refine(isCanonicalInstant, { message: "not a canonical instant" }).nullable().optional(),
    replacedBy: Key.nullable().optional(),
  })
  .passthrough();

export const SettingsVersionItemSchema = z.object({
  key: Key,
  label: Label,
  change: z.enum(SETTINGS_ITEM_CHANGES),
  before: ItemState,
  after: ItemState,
});

/** A version as written: everything but its id and tenant, which the writer stamps. */
export const SettingsVersionWriteSchema = z
  .object({
    subject: z.enum(SETTINGS_SUBJECTS),
    rev: z.number().int().min(1),
    state: z.enum(["draft", "live"]),
    savedAt: z.string().refine(isCanonicalInstant, { message: "not a canonical instant" }),
    by: EventActorSchema,
    message: z.string().max(SETTINGS_LIMITS.messageChars).nullable(),
    source: z.enum(SETTINGS_SOURCES),
    restoredFrom: z.number().int().min(1).nullable(),
    items: z.array(SettingsVersionItemSchema).max(SETTINGS_LIMITS.items),
    moreItems: z.number().int().min(0),
    snapshot: z.object({ items: z.array(SettingsItemSchema) }).passthrough(),
  })
  .superRefine((v, c) => {
    if (jsonBytes(v.snapshot) > SETTINGS_LIMITS.snapshotBytes) c.addIssue({ code: "custom", path: ["snapshot"], message: "snapshot_too_large" });
    if (jsonBytes(v.items) > SETTINGS_LIMITS.itemsBytes) c.addIssue({ code: "custom", path: ["items"], message: "items_too_large" });
    if ((v.source === "restore") !== (v.restoredFrom !== null)) c.addIssue({ code: "custom", path: ["restoredFrom"], message: "restoredFrom_only_on_a_restore" });
  });

export type SettingsVersionWrite = Omit<SettingsVersion, "id" | "tenantId">;

/**
 * The items a version lists: at most SETTINGS_LIMITS.items, and no more than itemsBytes of them,
 * in the order given. The rest are counted, so the version says how many more changed.
 */
export function capItems(items: SettingsVersionItem[]): { items: SettingsVersionItem[]; moreItems: number } {
  const kept: SettingsVersionItem[] = [];
  let bytes = 2; // the array's brackets
  for (const item of items) {
    if (kept.length >= SETTINGS_LIMITS.items) break;
    const size = jsonBytes(item) + 1;
    if (bytes + size > SETTINGS_LIMITS.itemsBytes) break;
    kept.push(item);
    bytes += size;
  }
  return { items: kept, moreItems: items.length - kept.length };
}
