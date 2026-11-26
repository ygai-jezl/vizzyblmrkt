import { FieldValue as Sentinel } from "firebase-admin/firestore";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { prepareEventsTx, regionalStoreFor, retryOnceOnExists, stageEvent } from "./ontologyEvents";
import { planAgentTransition, readAgentActionTx, stageAgentTransition, type AgentTransition, type AgentTransitionOk, type TransitionError } from "./agentActions";
import { RECORD_FIELD_LISTS, settingsDocId } from "./settingsLog";
import type { FirestoreLike, TenantContext } from "./types";
import { fieldTagRepair, fieldTagsForPerson, isInEveryone, sameFieldTags, withFieldTags } from "@/lib/audience/fieldTags";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { isCanonicalInstant, jsonBytes, type EventActor, type FieldChangeSource } from "@/lib/ontology/events";
import { isContactPersonId } from "@/lib/ontology/person";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import {
  checkFieldValue,
  FIELD_LIMITS,
  FIELD_LIST_SUBJECT,
  hasOptions,
  isFieldId,
  optionIdsOf,
  sameFieldValue,
  type FieldValue,
  type FieldValues,
  type RecordField,
  type RecordFieldObject,
} from "@/lib/types/recordField";

/**
 * The one writer of field values (piece B, AUDIENCE_FIELDS_ENABLED). A person's or a company's
 * values sit on the record under `fields.<fieldId>`; nothing else writes there (a source scan in
 * src/lib/audience/fields.test.ts keeps every other writer off it, and syncPerson never touches
 * it).
 *
 * In ONE transaction in the brand's regional database it reads the field list, the record and,
 * when a suggestion is being decided, the agent action; checks every change against the list as
 * read in that transaction (so a field archived at the same moment can't get a value); then writes
 * the dotted value patch, a person's `field:` tags in step with the values, one
 * record.field_changed event per changed value (people and companies both), and the action's
 * decision. Writing an unchanged value saves nothing.
 *
 * The whole record is budgeted to stay well under Firestore's 1 MiB document limit.
 */

/** The most a record may weigh after a change: Firestore's 1 MiB less headroom for its other writers. */
export const RECORD_BYTE_BUDGET = 900 * 1024;

const RECORD_COLLECTIONS = { person: "contacts", company: "companies" } as const satisfies Record<RecordFieldObject, string>;

export interface SetFieldValuesInput {
  object: RecordFieldObject;
  recordId: string;
  /** Field id to its new value; null clears it. */
  changes: Record<string, unknown>;
  by: EventActor;
  source: FieldChangeSource;
  /** The brand's current team members by user id: a new team member value must be one of them. */
  members?: ReadonlySet<string>;
  /** A suggestion this change decides: its move commits with the values (Vizzy's confirm). */
  agentAction?: { id: AgentActionId; transition: AgentTransition };
  /**
   * Refuse with `stale`, writing nothing, unless each of these fields still holds this value as
   * read in the transaction (null: no value). Vizzy's confirm passes the values its suggestion was
   * made from, and an undo the values the confirm set.
   */
  expect?: Record<string, unknown>;
  /**
   * Refuse with `stale`, writing nothing, when a changed field fails this as read in the
   * transaction. Vizzy's confirm passes "Vizzy may still read it" (vizzyReadsField), so a field an
   * admin stopped Vizzy reading a moment ago never gets its suggestion.
   */
  allowField?: (field: RecordField) => boolean;
  /**
   * The changes put back values this record held before (an undo): the options they name count as
   * held, so one archived since can come back. Otherwise only options the record holds now may
   * stay archived, and a newly chosen option must be live.
   */
  restoring?: boolean;
  nowIso?: string;
  /** Makes each event's key unique; inject one in tests. */
  nonce?: () => string;
}

export type SetFieldValuesError =
  | "not_found"
  | "unknown_field"
  | "archived_field"
  | "invalid_value"
  | "record_too_large"
  | "stale"
  | `agent_action_${TransitionError}`;

export type SetFieldValuesResult =
  | {
      ok: true;
      outcome: "updated" | "unchanged";
      /** Every value on the record after the write. */
      values: FieldValues;
      /** The field ids whose value changed. */
      changed: string[];
      events: StoredEvent[];
      agentAction: AgentAction | null;
      /** Field tags past MAX_FIELD_TAGS, left off (a person only). */
      droppedTags: number;
    }
  | { ok: false; error: SetFieldValuesError; fieldId?: string; reason?: string };

function now(nowIso?: string): string {
  if (nowIso === undefined) return new Date().toISOString();
  if (!isCanonicalInstant(nowIso)) throw new TenantValidationError("nowIso must be canonical (toISOString)");
  return nowIso;
}

/** The record after a dotted patch, for the size budget: `fields.<id>` keys land in the fields map. */
function applied(current: Record<string, unknown>, values: FieldValues, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, fields: values };
  for (const [k, v] of Object.entries(patch)) if (!k.startsWith("fields.")) next[k] = v;
  return next;
}

/**
 * Set some of a record's field values, with their events and tags, in one transaction. Refuses
 * the whole write for an unknown or archived field, a value its type doesn't allow (an archived
 * option counts only while the record already holds it), a team member
 * who isn't on the team, a field that no longer holds what `expect` says or fails `allowField`, or
 * a record that would outgrow the budget. With `agentAction`, a move
 * that can't happen refuses with `agent_action_<error>`, and a decision with no value to change is
 * still recorded.
 */
export async function setRecordFieldValues(ctx: TenantContext, input: SetFieldValuesInput, opts: { db?: FirestoreLike } = {}): Promise<SetFieldValuesResult> {
  const collection = RECORD_COLLECTIONS[input.object];
  if (!collection) throw new TenantValidationError("setFieldValues takes a person or a company");
  if (!input.recordId || typeof input.recordId !== "string") throw new TenantValidationError("setFieldValues needs a record id");
  if (input.object === "person" && !isContactPersonId(input.recordId)) return { ok: false, error: "not_found" };
  const entries = Object.entries(input.changes ?? {});
  if (entries.length > FIELD_LIMITS.liveFields) return { ok: false, error: "invalid_value", reason: "too_many_changes" };
  for (const [fieldId] of entries) if (!isFieldId(fieldId)) return { ok: false, error: "unknown_field", fieldId: String(fieldId).slice(0, 64) };
  const nowIso = now(input.nowIso);
  const store = regionalStoreFor(ctx, opts.db);
  const subject = FIELD_LIST_SUBJECT[input.object];
  const listRef = store.collection(RECORD_FIELD_LISTS).doc(settingsDocId(ctx.tenantId, subject));
  const recordRef = store.collection(RECORD_COLLECTIONS[input.object]).doc(input.recordId);

  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<SetFieldValuesResult> => {
      // Read phase: the list, the record and the action, before any write.
      const listSnap = await txn.get(listRef);
      const recordSnap = await txn.get(recordRef);
      const action = input.agentAction ? await readAgentActionTx(txn, store, ctx, input.agentAction.id) : null;
      let fields: RecordField[] = [];
      if (listSnap.exists) {
        const data = listSnap.data() ?? {};
        if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${RECORD_FIELD_LISTS}/${listRef.id} belongs to another tenant`);
        fields = Array.isArray(data.items) ? (data.items as RecordField[]) : [];
      }
      if (!recordSnap.exists) return { ok: false, error: "not_found" };
      const record = recordSnap.data() ?? {};
      if (record[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${collection}/${input.recordId} belongs to another tenant`);
      let move: AgentTransitionOk | null = null;
      if (input.agentAction) {
        const planned = planAgentTransition(action, input.agentAction.transition);
        if (!planned.ok) return { ok: false, error: `agent_action_${planned.error}` };
        move = planned;
      }

      // Every change against the list as read here.
      const byId = new Map(fields.map((f) => [f.key, f]));
      const before = (record.fields && typeof record.fields === "object" ? record.fields : {}) as FieldValues;
      for (const [fieldId, want] of Object.entries(input.expect ?? {})) {
        if (!sameFieldValue(before[fieldId] ?? null, (want ?? null) as FieldValue | null)) return { ok: false, error: "stale", fieldId };
      }
      const values: FieldValues = { ...before };
      const patch: Record<string, unknown> = {};
      const changed: Array<{ field: RecordField; before: FieldValue | null; after: FieldValue | null }> = [];
      for (const [fieldId, raw] of entries) {
        const field = byId.get(fieldId);
        if (!field) return { ok: false, error: "unknown_field", fieldId };
        if (field.archivedAt) return { ok: false, error: "archived_field", fieldId };
        if (input.allowField && !input.allowField(field)) return { ok: false, error: "stale", fieldId };
        // Options the value holds now (or held before, for an undo) may stay though archived since.
        const held = hasOptions(field.type) ? new Set([...optionIdsOf(before[fieldId]), ...(input.restoring ? optionIdsOf(raw) : [])]) : undefined;
        const check = checkFieldValue(field, raw, held);
        if (!check.ok) return { ok: false, error: "invalid_value", fieldId, reason: check.reason };
        const was = before[fieldId] ?? null;
        if (sameFieldValue(was, check.value)) continue;
        if (field.type === "team_member" && check.value !== null && !input.members?.has(check.value as string)) {
          return { ok: false, error: "invalid_value", fieldId, reason: "not_on_team" };
        }
        if (check.value === null) {
          delete values[fieldId];
          patch[`fields.${fieldId}`] = Sentinel.delete();
        } else {
          values[fieldId] = check.value;
          patch[`fields.${fieldId}`] = check.value;
        }
        changed.push({ field, before: was, after: check.value });
      }

      // A person's field tags follow their values while they are in Everyone; every other tag stays as it is.
      let droppedTags = 0;
      if (input.object === "person" && changed.length) {
        const current = Array.isArray(record.memberOf) ? (record.memberOf as string[]) : [];
        const next = fieldTagsForPerson(fields, values, current);
        droppedTags = next.dropped;
        if (!sameFieldTags(current, next.tags)) {
          patch.memberOf = withFieldTags(current, next.tags);
          patch.changedAt = nowIso;
        }
        if (droppedTags) console.warn(`[fields] ${ctx.tenantId}: ${droppedTags} field tags left off one person (over the cap)`);
      }
      if (changed.length) patch.updatedAt = nowIso;
      if (changed.length && jsonBytes(applied(record, values, patch)) > RECORD_BYTE_BUDGET) return { ok: false, error: "record_too_large" };

      const events = changed.map((c) =>
        fieldChangedEvent({
          subject: { type: input.object, id: input.recordId },
          personId: input.object === "person" ? (input.recordId as `ct_${string}`) : null,
          fieldId: c.field.key,
          object: input.object,
          before: c.before,
          after: c.after,
          source: input.source,
          actor: input.by,
          at: nowIso,
          agentActionId: input.agentAction?.id ?? null,
          ...(input.nonce ? { nonce: input.nonce } : {}),
        }),
      );
      if (!changed.length && !move) {
        return { ok: true, outcome: "unchanged", values, changed: [], events: [], agentAction: null, droppedTags: 0 };
      }
      // Still the read phase: every event's ref.
      const { fresh } = await prepareEventsTx(txn, store, ctx, events);

      if (Object.keys(patch).length) txn.update(recordRef, patch);
      const written = fresh.map((e) => stageEvent(txn, store, ctx, e, nowIso));
      if (move) written.push(...stageAgentTransition(txn, store, ctx, move));
      return {
        ok: true,
        outcome: "updated",
        values,
        changed: changed.map((c) => c.field.key),
        events: written,
        agentAction: move ? move.next : null,
        droppedTags,
      };
    }),
  );
}

export interface MoveFieldValuesResult {
  /** moved: something was written. unchanged: nothing to move. skipped: see `reason`. */
  outcome: "moved" | "unchanged" | "skipped";
  /** Why nothing was written: the old record is still someone in People, or the new one is missing. */
  reason?: "still_a_person" | "no_target";
  /**
   * With still_a_person: the old record owes a full sync (`needsSync`, a write couldn't make it),
   * so it may only look like someone in People until that sync is made.
   */
  owesSync?: boolean;
  /** Field ids copied to the new record and cleared from the old one. */
  moved: string[];
  /** Field ids the new record already held with the same value: cleared from the old one only. */
  same: string[];
  /** Field ids the new record holds another value for: its own value wins, the old one stays. */
  kept: string[];
  /** Field ids that would push the new record past its budget: left on the old one. */
  tooLarge: string[];
  /**
   * Field ids whose values are being erased (`erasingSince`, Settings › History): cleared from the old
   * record and never moved, with no event, since one would copy the value into its `before`.
   */
  dropped: string[];
  /** The old record holds no values after this. */
  emptied: boolean;
  /** The old record's key (its address, phone or pu: key), to sync it once emptied. Never log it. */
  fromKey: string | null;
}

/**
 * A person's field values follow them to a new record (a product user's address change, or a pu:
 * record merged into an address), in ONE transaction: each value goes to the new record where it
 * has none for that field (the new record's own values win, and a value it already holds just
 * leaves the old record), with a record.field_changed on the new record (source "sync") and one
 * clearing it on the old, and both records' field tags in step. Archived fields' values move too.
 * A value that would push the new record past RECORD_BYTE_BUDGET stays on the old one. A field
 * whose values are being erased (`erasingSince`) is dropped from the old record instead of moved,
 * with no event, so an erase that is part way through never has a value move ahead of it.
 *
 * Only off a record the move left behind: one still in Everyone (a sign-up, another product user,
 * added by hand) is still someone in People and keeps its values. Idempotent: a moved value is no
 * longer on the old record, so running it again writes nothing, and each event's key carries both
 * records, the field and the moment, so a retried transaction writes nothing twice.
 */
export async function moveRecordFieldValues(
  ctx: TenantContext,
  input: { from: string; to: string; nowIso?: string },
  opts: { db?: FirestoreLike } = {},
): Promise<MoveFieldValuesResult> {
  const nothing = (over: Partial<MoveFieldValuesResult> = {}): MoveFieldValuesResult => ({
    outcome: "unchanged",
    moved: [],
    same: [],
    kept: [],
    tooLarge: [],
    dropped: [],
    emptied: false,
    fromKey: null,
    ...over,
  });
  if (!isContactPersonId(input.from) || !isContactPersonId(input.to)) throw new TenantValidationError("moveRecordFieldValues takes two person ids");
  if (input.from === input.to) return nothing();
  const nowIso = now(input.nowIso);
  const store = regionalStoreFor(ctx, opts.db);
  const listRef = store.collection(RECORD_FIELD_LISTS).doc(settingsDocId(ctx.tenantId, FIELD_LIST_SUBJECT.person));
  const fromRef = store.collection("contacts").doc(input.from);
  const toRef = store.collection("contacts").doc(input.to);
  const from = input.from as `ct_${string}`;
  const to = input.to as `ct_${string}`;
  const system: EventActor = { type: "system", id: null };

  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<MoveFieldValuesResult> => {
      const listSnap = await txn.get(listRef);
      const fromSnap = await txn.get(fromRef);
      const toSnap = await txn.get(toRef);
      if (!fromSnap.exists) return nothing();
      const old = fromSnap.data() ?? {};
      if (old[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`contacts/${input.from} belongs to another tenant`);
      const oldValues = (old.fields && typeof old.fields === "object" ? old.fields : {}) as FieldValues;
      const ids = Object.keys(oldValues).filter(isFieldId).sort();
      const fromKey = typeof old.contactKey === "string" ? old.contactKey : null;
      if (!ids.length) return nothing({ emptied: true, fromKey });
      const oldTags = Array.isArray(old.memberOf) ? (old.memberOf as string[]) : [];
      if (isInEveryone(oldTags)) return nothing({ outcome: "skipped", reason: "still_a_person", fromKey, owesSync: old.needsSync === true });
      if (!toSnap.exists) return nothing({ outcome: "skipped", reason: "no_target", fromKey });
      const record = toSnap.data() ?? {};
      if (record[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`contacts/${input.to} belongs to another tenant`);
      let fields: RecordField[] = [];
      if (listSnap.exists) {
        const data = listSnap.data() ?? {};
        if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${RECORD_FIELD_LISTS}/${listRef.id} belongs to another tenant`);
        fields = Array.isArray(data.items) ? (data.items as RecordField[]) : [];
      }

      const newValues: FieldValues = { ...((record.fields && typeof record.fields === "object" ? record.fields : {}) as FieldValues) };
      const leftValues: FieldValues = { ...oldValues };
      const toPatch: Record<string, unknown> = {};
      const fromPatch: Record<string, unknown> = {};
      const out = nothing({ fromKey });
      const erasing = new Set(fields.filter((f) => f.erasingSince).map((f) => f.key));
      for (const id of ids) {
        const value = oldValues[id]!;
        if (erasing.has(id)) {
          out.dropped.push(id);
          delete leftValues[id];
          fromPatch[`fields.${id}`] = Sentinel.delete();
          continue;
        }
        const theirs = newValues[id] ?? null;
        if (theirs !== null) {
          // The new record's own value wins; the same value only leaves the old record.
          if (!sameFieldValue(theirs, value)) {
            out.kept.push(id);
            continue;
          }
          out.same.push(id);
        } else {
          newValues[id] = value;
          toPatch[`fields.${id}`] = value;
          // A value is moved only while the new record stays inside its budget.
          if (jsonBytes(applied(record, newValues, toPatch)) > RECORD_BYTE_BUDGET) {
            delete newValues[id];
            delete toPatch[`fields.${id}`];
            out.tooLarge.push(id);
            continue;
          }
          out.moved.push(id);
        }
        delete leftValues[id];
        fromPatch[`fields.${id}`] = Sentinel.delete();
      }
      if (!out.moved.length && !out.same.length && !out.dropped.length) return { ...out, outcome: "unchanged", emptied: false };

      // Both records' field tags follow their values (none while out of Everyone).
      if (out.moved.length) {
        const current = Array.isArray(record.memberOf) ? (record.memberOf as string[]) : [];
        const next = fieldTagsForPerson(fields, newValues, current);
        if (!sameFieldTags(current, next.tags)) {
          toPatch.memberOf = withFieldTags(current, next.tags);
          toPatch.changedAt = nowIso;
        }
        if (next.dropped) console.warn(`[fields] ${ctx.tenantId}: ${next.dropped} field tags left off one person (over the cap)`);
        toPatch.updatedAt = nowIso;
      }
      const oldNext = fieldTagsForPerson(fields, leftValues, oldTags);
      if (!sameFieldTags(oldTags, oldNext.tags)) fromPatch.memberOf = withFieldTags(oldTags, oldNext.tags);
      fromPatch.updatedAt = nowIso;

      const key = (id: string, side: "in" | "out") => `fieldmove|${from}|${to}|${id}|${nowIso}|${side}`;
      const events = [
        ...out.moved.map((id) =>
          fieldChangedEvent({ subject: { type: "person", id: to }, personId: to, fieldId: id, object: "person", before: null, after: oldValues[id], source: "sync", actor: system, at: nowIso, key: key(id, "in") }),
        ),
        ...[...out.moved, ...out.same].sort().map((id) =>
          fieldChangedEvent({ subject: { type: "person", id: from }, personId: from, fieldId: id, object: "person", before: oldValues[id], after: null, source: "sync", actor: system, at: nowIso, key: key(id, "out") }),
        ),
      ];
      const { fresh } = await prepareEventsTx(txn, store, ctx, events);
      if (Object.keys(toPatch).length) txn.update(toRef, toPatch);
      txn.update(fromRef, fromPatch);
      for (const e of fresh) stageEvent(txn, store, ctx, e, nowIso);
      return { ...out, outcome: "moved", emptied: Object.keys(leftValues).filter(isFieldId).length === 0 };
    }),
  );
}

export interface EraseFieldValuesPage {
  /** Records read on this page. */
  scanned: number;
  /** Of them, those holding a value or a tag for the field. */
  holders: number;
  /** Of those, the ones whose value and tags were removed (0 on a count). */
  erased: number;
  /** The page's last id: the next page's `after`. */
  last: string | null;
  more: boolean;
  /** Set when the erase stopped: the field is in use again, or no longer marked as erasing. */
  stopped?: "field_live";
}

/**
 * One page of an archived field's erase (Settings › History, ADR-0023): the brand's people or
 * companies in document id order (an equality on the brand, so no composite index, and a company's
 * updatedAt, which the erase changes, never decides the order). Each one holding `fields.<id>` or a
 * `field:<id>:` tag loses both in one transaction that first re-reads the field list: unless the
 * field is still archived and marked `erasingSince`, nothing is written and the page says
 * `stopped`. It writes no record.field_changed event, since one would copy the value into its
 * `before`. A count (`dryRun`) reads the same page and writes nothing. Resumable from `last`.
 */
export async function eraseFieldValuesPage(
  ctx: TenantContext,
  input: { object: RecordFieldObject; fieldId: string; after?: string | null; limit?: number; dryRun?: boolean; nowIso?: string },
  opts: { db?: FirestoreLike } = {},
): Promise<EraseFieldValuesPage> {
  if (!isFieldId(input.fieldId)) throw new TenantValidationError("eraseFieldValuesPage takes a field id the brand made");
  const collection = RECORD_COLLECTIONS[input.object];
  if (!collection) throw new TenantValidationError("eraseFieldValuesPage takes a person or a company");
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 200)), 400);
  const nowIso = now(input.nowIso);
  const store = regionalStoreFor(ctx, opts.db);
  const tagPrefix = `field:${input.fieldId}:`;
  let q = store.collection(RECORD_COLLECTIONS[input.object]).where(TENANT_FIELD, "==", ctx.tenantId).orderBy("__name__", "asc");
  if (q.select) q = q.select(TENANT_FIELD, "fields", "memberOf");
  if (input.after) q = q.startAfter(input.after);
  const snap = await q.limit(limit).get();
  const holds = (data: Record<string, unknown>) => {
    const values = data.fields && typeof data.fields === "object" ? (data.fields as Record<string, unknown>) : {};
    const tags = Array.isArray(data.memberOf) ? (data.memberOf as unknown[]) : [];
    return Object.hasOwn(values, input.fieldId) || tags.some((t) => typeof t === "string" && t.startsWith(tagPrefix));
  };
  const holderIds = snap.docs.filter((d) => (d.data() ?? {})[TENANT_FIELD] === ctx.tenantId && holds(d.data() ?? {})).map((d) => d.id);
  const page: EraseFieldValuesPage = {
    scanned: snap.docs.length,
    holders: holderIds.length,
    erased: 0,
    last: snap.docs.length ? snap.docs[snap.docs.length - 1]!.id : (input.after ?? null),
    more: snap.docs.length === limit,
  };
  if (input.dryRun) return page;
  const listRef = store.collection(RECORD_FIELD_LISTS).doc(settingsDocId(ctx.tenantId, FIELD_LIST_SUBJECT[input.object]));
  return store.runTransaction(async (txn): Promise<EraseFieldValuesPage> => {
    const listSnap = await txn.get(listRef);
    const refs = holderIds.map((id) => store.collection(RECORD_COLLECTIONS[input.object]).doc(id));
    const snaps = await Promise.all(refs.map((ref) => txn.get(ref)));
    const list = listSnap.exists ? (listSnap.data() ?? {}) : {};
    if (listSnap.exists && list[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${RECORD_FIELD_LISTS}/${listRef.id} belongs to another tenant`);
    const field = (Array.isArray(list.items) ? (list.items as RecordField[]) : []).find((f) => f.key === input.fieldId);
    if (!field || !field.archivedAt || !field.erasingSince) return { ...page, holders: 0, more: false, stopped: "field_live" };
    let erased = 0;
    snaps.forEach((s, i) => {
      if (!s.exists) return;
      const data = s.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${collection}/${refs[i]!.id} belongs to another tenant`);
      if (!holds(data)) return;
      const patch: Record<string, unknown> = { updatedAt: nowIso };
      const values = data.fields && typeof data.fields === "object" ? (data.fields as Record<string, unknown>) : {};
      if (Object.hasOwn(values, input.fieldId)) patch[`fields.${input.fieldId}`] = Sentinel.delete();
      const tags = Array.isArray(data.memberOf) ? (data.memberOf as string[]) : [];
      const kept = tags.filter((t) => !(typeof t === "string" && t.startsWith(tagPrefix)));
      if (kept.length !== tags.length) {
        patch.memberOf = kept;
        if (input.object === "person") patch.changedAt = nowIso;
      }
      txn.update(refs[i]!, patch);
      erased += 1;
    });
    return { ...page, erased };
  });
}

/**
 * Rebuild one person's field tags from their stored values, for values written before the tags
 * existed (scripts/backfill-field-tags.ts) and after a sync brings someone back into Everyone.
 * Every other tag stays; someone not in Everyone has none. Reads the list and the person in one
 * transaction; a dry run writes nothing. Safe to run again.
 */
export async function repairFieldTags(
  ctx: TenantContext,
  personId: string,
  opts: { dryRun?: boolean; db?: FirestoreLike } = {},
): Promise<"updated" | "unchanged" | "missing"> {
  const store = regionalStoreFor(ctx, opts.db);
  const listRef = store.collection(RECORD_FIELD_LISTS).doc(settingsDocId(ctx.tenantId, FIELD_LIST_SUBJECT.person));
  const recordRef = store.collection("contacts").doc(personId);
  return store.runTransaction(async (txn) => {
    const listSnap = await txn.get(listRef);
    const recordSnap = await txn.get(recordRef);
    if (!recordSnap.exists) return "missing";
    const record = recordSnap.data() ?? {};
    if (record[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`contacts/${personId} belongs to another tenant`);
    const list = listSnap.exists ? (listSnap.data() ?? {}) : {};
    if (listSnap.exists && list[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${RECORD_FIELD_LISTS}/${listRef.id} belongs to another tenant`);
    const plan = fieldTagRepair(
      Array.isArray(list.items) ? (list.items as RecordField[]) : [],
      record.fields as FieldValues | undefined,
      Array.isArray(record.memberOf) ? (record.memberOf as string[]) : [],
    );
    if (!plan) return "unchanged";
    if (!opts.dryRun) txn.update(recordRef, { memberOf: plan.memberOf });
    return "updated";
  });
}
