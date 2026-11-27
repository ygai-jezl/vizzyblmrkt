import { TENANT_FIELD } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { regionalStoreFor } from "./ontologyEvents";
import type { FirestoreLike, TenantContext, TransactionLike } from "./types";
import { deterministicSettingsSubjectId } from "@/lib/crm/identifiers";
import { isCanonicalInstant, type EventActor } from "@/lib/ontology/events";
import { assertNoRemoval, describeItemChanges } from "@/lib/settings/archive";
import {
  capItems,
  SettingsVersionWriteSchema,
  type SettingsList,
  type SettingsSource,
  type SettingsSubject,
  type SettingsVersion,
  type SettingsVersionItem,
  type SettingsVersionWrite,
} from "@/lib/types/settingsVersion";

/**
 * The settings log's only writer (piece O part 1). A setting, such as a brand's People field
 * list, and the version that records its change are written in ONE transaction in the brand's
 * regional database, so a change is never saved without its version, nor a version without its
 * change.
 *
 * - The setting's `rev` is kept on its own document, and a version's id is the brand, subject and
 *   rev, so a write reads two documents by id and needs no query or index.
 * - A save names the rev it was made from. When the setting has moved on it returns
 *   `settings_changed` with what is there now; a route answers 409, as `catalog_changed` does.
 *   A retry of a save that already landed sees the new rev, so it never writes a second version.
 * - Versions are created, never updated or deleted (forTenant gives them read only).
 * - Items are archived, never removed: every save goes through assertNoRemoval.
 * - Errors reach the caller; nothing is swallowed.
 * - prepareSettingsChange is the same save inside a transaction the caller runs, so a writer in
 *   src/lib/tenant can save a setting beside another change in the same database (a brand's part of
 *   an organisation's connection, Connectors 3). It is not exported from @/lib/tenant.
 */

export const SETTINGS_VERSIONS = "settings_versions";

/** The People and Company field lists' collection (src/lib/tenant/recordFieldWrites.ts reads it in its transaction). */
export const RECORD_FIELD_LISTS = "record_field_lists";

/** The parts a brand's organisation gives it (Connectors 3): its `connections:shared` setting's collection. */
export const CONNECTION_PARTS = "connection_parts";

/** Where each subject's live setting is kept: one document per brand and subject, id settingsDocId. */
export const SETTINGS_HOMES = {
  "fields:person": "record_field_lists",
  "fields:company": "record_field_lists",
  "connections:shared": "connection_parts",
  // The team's saved views on People (piece C), one document per brand.
  "views:person": "saved_views",
} as const satisfies Record<SettingsSubject, string>;

/** The fields the log keeps on a setting's document beside the setting itself. */
const LOG_FIELDS = [TENANT_FIELD, "id", "subject", "rev", "updatedAt"] as const;

/** The live setting's document id: `ss_` and a hash of the brand and subject. */
export function settingsDocId(tenantId: string, subject: SettingsSubject): string {
  return deterministicSettingsSubjectId(tenantId, subject);
}

/** `ss_<40 hex>_r000012`: one per brand, subject and rev, so a retried write can't duplicate it. */
export function settingsVersionId(tenantId: string, subject: SettingsSubject, rev: number): string {
  return `${settingsDocId(tenantId, subject)}_r${String(rev).padStart(6, "0")}`;
}

/** A setting as stored: the setting, the rev of its last save (0 for never) and when that was. */
export interface StoredSetting<V extends SettingsList = SettingsList> {
  value: V;
  rev: number;
  updatedAt: string | null;
}

function toStored<V extends SettingsList>(data: Record<string, unknown>): StoredSetting<V> {
  const value = { ...data };
  for (const k of LOG_FIELDS) delete value[k];
  return {
    value: value as unknown as V,
    rev: typeof data.rev === "number" ? data.rev : 0,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  };
}

/** The live setting, or null when it has never been saved. Another brand's document reads as none. */
export async function readSetting<V extends SettingsList = SettingsList>(
  ctx: TenantContext,
  subject: SettingsSubject,
  db?: FirestoreLike,
): Promise<StoredSetting<V> | null> {
  const store = regionalStoreFor(ctx, db);
  const snap = await store.collection(SETTINGS_HOMES[subject]).doc(settingsDocId(ctx.tenantId, subject)).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (data[TENANT_FIELD] !== ctx.tenantId) return null;
  return toStored<V>(data);
}

export interface SettingsChange<V extends SettingsList> {
  subject: SettingsSubject;
  /** The rev the change was made from: 0 when the setting has never been saved. */
  baseRev: number;
  /** The whole setting after the change. Keep it under SETTINGS_LIMITS.snapshotBytes. */
  value: V;
  /** Who or what saved it, by id only. */
  by: EventActor;
  source: Exclude<SettingsSource, "before_history">;
  /** For a restore: the rev it brings back. */
  restoredFrom?: number;
  /** Why, in the saver's words (up to 200 characters). */
  message?: string | null;
  /** The items that changed. Omitted: worked out from the setting before and after. */
  items?: SettingsVersionItem[];
  nowIso?: string;
}

export type SettingsCommit<V extends SettingsList> =
  | { ok: true; rev: number; version: SettingsVersion }
  | { ok: false; error: "settings_changed"; current: StoredSetting<V> | null };

function badVersion(issue: { path: PropertyKey[]; message: string } | undefined): TenantValidationError {
  return new TenantValidationError(`bad_settings_version:${issue ? `${issue.path.map(String).join(".")}:${issue.message}` : "invalid"}`);
}

/** A change checked before any read: a bad rev, time or reserved field throws. */
function checkChange<V extends SettingsList>(change: SettingsChange<V>): string {
  if (!Number.isInteger(change.baseRev) || change.baseRev < 0) throw new TenantValidationError("baseRev must be a whole number from 0");
  const nowIso = change.nowIso ?? new Date().toISOString();
  if (!isCanonicalInstant(nowIso)) throw new TenantValidationError("nowIso must be canonical (toISOString)");
  for (const k of LOG_FIELDS) {
    if (Object.hasOwn(change.value, k)) throw new TenantValidationError(`reserved_settings_field:${k}`);
  }
  return nowIso;
}

/** A save read and checked in the caller's transaction, with its writes still to stage. */
export type PreparedSettingsChange<V extends SettingsList> =
  | { ok: true; rev: number; version: SettingsVersion; stage: () => void }
  | { ok: false; error: "settings_changed"; current: StoredSetting<V> | null };

/**
 * Read a setting and its next version in the caller's transaction and check the save, staging
 * nothing yet: call `stage` after every read of the transaction. Throws as commitSettingsChange does.
 * For writers in src/lib/tenant only.
 */
export async function prepareSettingsChange<V extends SettingsList>(
  ctx: TenantContext,
  change: SettingsChange<V>,
  txn: TransactionLike,
  store: FirestoreLike,
): Promise<PreparedSettingsChange<V>> {
  const nowIso = checkChange(change);
  const rev = change.baseRev + 1;
  const settingRef = store.collection(SETTINGS_HOMES[change.subject]).doc(settingsDocId(ctx.tenantId, change.subject));
  const versionRef = store.collection(SETTINGS_VERSIONS).doc(settingsVersionId(ctx.tenantId, change.subject, rev));

  // All reads first.
  const settingSnap = await txn.get(settingRef);
  const versionSnap = await txn.get(versionRef);
  let current: StoredSetting<V> | null = null;
  if (settingSnap.exists) {
    const data = settingSnap.data() ?? {};
    if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${SETTINGS_HOMES[change.subject]}/${settingRef.id} belongs to another tenant`);
    current = toStored<V>(data);
  }
  if ((current?.rev ?? 0) !== change.baseRev) return { ok: false, error: "settings_changed", current };
  if (versionSnap.exists) {
    if ((versionSnap.data() ?? {})[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${SETTINGS_VERSIONS}/${versionRef.id} belongs to another tenant`);
    // The setting is at baseRev, yet the next version is there: never overwrite it.
    throw new TenantValidationError(`settings_version_exists:${versionRef.id}`);
  }

  const before = current?.value.items ?? [];
  assertNoRemoval(before, change.value.items);
  const { items, moreItems } = capItems(change.items ?? describeItemChanges(before, change.value.items));
  const write: SettingsVersionWrite = {
    subject: change.subject,
    rev,
    state: "live",
    savedAt: nowIso,
    by: change.by,
    message: change.message?.trim() ? change.message.trim() : null,
    source: change.source,
    restoredFrom: change.restoredFrom ?? null,
    items,
    moreItems,
    snapshot: change.value as unknown as SettingsVersionWrite["snapshot"],
  };
  const parsed = SettingsVersionWriteSchema.safeParse(write);
  if (!parsed.success) throw badVersion(parsed.error.issues[0]);

  const doc: Record<string, unknown> = { ...(change.value as unknown as Record<string, unknown>), subject: change.subject, rev, updatedAt: nowIso, [TENANT_FIELD]: ctx.tenantId };
  return {
    ok: true,
    rev,
    version: { ...write, id: versionRef.id, tenantId: ctx.tenantId },
    stage: () => {
      if (settingSnap.exists) txn.set(settingRef, doc);
      else txn.create(settingRef, doc);
      txn.create(versionRef, { ...write, [TENANT_FIELD]: ctx.tenantId });
    },
  };
}

/**
 * Save a setting and its version together. Returns the new rev and version, or
 * `settings_changed` with the setting as it is now when `baseRev` is out of date. Throws
 * TenantIsolationError when either document belongs to another brand, SettingsRemovalError when
 * an item would be lost, and TenantValidationError for a version that breaks its caps.
 */
export async function commitSettingsChange<V extends SettingsList>(
  ctx: TenantContext,
  change: SettingsChange<V>,
  db?: FirestoreLike,
): Promise<SettingsCommit<V>> {
  const nowIso = checkChange(change);
  const store = regionalStoreFor(ctx, db);
  return store.runTransaction(async (txn): Promise<SettingsCommit<V>> => {
    const prepared = await prepareSettingsChange(ctx, { ...change, nowIso }, txn, store);
    if (!prepared.ok) return prepared;
    prepared.stage();
    return { ok: true, rev: prepared.rev, version: prepared.version };
  });
}
