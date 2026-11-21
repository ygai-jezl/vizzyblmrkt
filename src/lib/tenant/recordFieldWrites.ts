import { FieldValue as Sentinel } from "firebase-admin/firestore";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { prepareEventsTx, regionalStoreFor, retryOnceOnExists, stageEvent } from "./ontologyEvents";
import { planAgentTransition, readAgentActionTx, stageAgentTransition, type AgentTransition, type AgentTransitionOk, type TransitionError } from "./agentActions";
import { RECORD_FIELD_LISTS, settingsDocId } from "./settingsLog";
import type { FirestoreLike, TenantContext } from "./types";
import { fieldTagsFor, sameFieldTags, withFieldTags } from "@/lib/audience/fieldTags";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { isCanonicalInstant, jsonBytes, type EventActor, type FieldChangeSource } from "@/lib/ontology/events";
import { isContactPersonId } from "@/lib/ontology/person";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import {
  checkFieldValue,
  FIELD_LIMITS,
  FIELD_LIST_SUBJECT,
  isFieldId,
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
 * the whole write for an unknown or archived field, a value its type doesn't allow, a team member
 * who isn't on the team, or a record that would outgrow the budget. With `agentAction`, a move
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
      const values: FieldValues = { ...before };
      const patch: Record<string, unknown> = {};
      const changed: Array<{ field: RecordField; before: FieldValue | null; after: FieldValue | null }> = [];
      for (const [fieldId, raw] of entries) {
        const field = byId.get(fieldId);
        if (!field) return { ok: false, error: "unknown_field", fieldId };
        if (field.archivedAt) return { ok: false, error: "archived_field", fieldId };
        const check = checkFieldValue(field, raw);
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

      // A person's field tags follow their values; every other tag stays as it is.
      let droppedTags = 0;
      if (input.object === "person" && changed.length) {
        const current = Array.isArray(record.memberOf) ? (record.memberOf as string[]) : [];
        const next = fieldTagsFor(fields, values);
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
