import { EventWriteSchema, type EventWrite } from "@/lib/types/ontologyEvent";
import type { AgentActionId } from "@/lib/types/agentAction";
import type { ConsentPurpose } from "./consent";
import { subjectKey, type EventActor, type EventSubject, type FieldChangeSource, type FieldObject } from "./events";
import type { ContactPersonId } from "./person";

/**
 * Builders for the event history's rows: each gives an EventWrite that the writers in
 * src/lib/tenant/ontologyEvents.ts accept. Pure (no Firestore, no Node), so a bad input throws
 * here, at build time, not at commit.
 *
 * Keys make a write idempotent: the same key in the same brand is stored once. Recommended keys
 * for consumers:
 * - a field change (the default here): `field|<subjectKey>|<fieldId>|<nonce>`, unique per
 *   committed change. A retried transaction makes a new nonce and only one attempt commits, so
 *   dedupe never fires for these keys, by design;
 * - B5's stage and tag moves: `move|<personId>|<changedAt>|<tag>`, deterministic, so a retried
 *   sync writes nothing twice;
 * - agent steps: `agent|<actionId>|<rev>`, written by the tenant layer only.
 * Never an address or a name in a key.
 *
 * productUserId goes on a row only when the row is about one product user's own data (B5's
 * product-derived moves), never on a change to the person as a whole, so erasing one product
 * never removes the person's own history.
 */

/** The instant in the one stored form (toISOString), or an error for one that isn't a time. */
function canonical(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error("bad_event_at");
  return new Date(ms).toISOString();
}

/** The write, checked: a bad one throws with the field and the rule, never the value. */
function checked(write: EventWrite): EventWrite {
  const parsed = EventWriteSchema.safeParse(write);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`bad_event:${issue ? `${issue.path.join(".")}:${issue.message}` : "invalid"}`);
  }
  return parsed.data as EventWrite;
}

export interface FieldChangedArgs {
  subject: EventSubject;
  /** The person, for a person subject (equal to subject.id); null for a company or an idea. */
  personId: ContactPersonId | null;
  fieldId: string;
  object: FieldObject;
  before: unknown;
  after: unknown;
  source: FieldChangeSource;
  actor: EventActor;
  at: string;
  /** Only on a change about one product user's own data. */
  productUserId?: string | null;
  /** The agent action that made the change, when one did. */
  agentActionId?: AgentActionId | null;
  key?: string;
  /** Makes the default key unique; inject one in tests. */
  nonce?: () => string;
}

/** One field's change on a person, company or idea, with its value before and after. */
export function fieldChangedEvent(a: FieldChangedArgs): EventWrite {
  const nonce = a.nonce ?? (() => globalThis.crypto.randomUUID());
  return checked({
    key: a.key ?? `field|${subjectKey(a.subject)}|${a.fieldId}|${nonce()}`,
    kind: "record.field_changed",
    at: canonical(a.at),
    subject: a.subject,
    personId: a.personId,
    productUserId: a.productUserId ?? null,
    fieldId: a.fieldId,
    agentActionId: a.agentActionId ?? null,
    source: { system: a.source === "agent" ? "agent" : "app" },
    actor: a.actor,
    properties: { fieldId: a.fieldId, object: a.object, before: a.before ?? null, after: a.after ?? null, source: a.source },
  });
}

export interface RecordCreatedArgs {
  subject: EventSubject;
  personId: ContactPersonId | null;
  /** How it was created, e.g. "form", "palette" or "vizzy". */
  via: string;
  actor: EventActor;
  at: string;
  /** The agent action that filled it, when one did. */
  agentActionId?: AgentActionId | null;
  key?: string;
}

/**
 * A person, company or idea created. The default key carries the time, so a person removed by a
 * sync and created again later never collides with their first row.
 */
export function recordCreatedEvent(a: RecordCreatedArgs): EventWrite {
  if (a.subject.type === "agent_action") throw new Error("bad_event:subject:an agent action is created through proposeAgentAction");
  const at = canonical(a.at);
  return checked({
    key: a.key ?? `created|${subjectKey(a.subject)}|${at}`,
    kind: "record.created",
    at,
    subject: a.subject,
    personId: a.personId,
    agentActionId: a.agentActionId ?? null,
    source: { system: a.agentActionId ? "agent" : "app" },
    actor: a.actor,
    properties: { object: a.subject.type, via: a.via },
  });
}

export interface ConsentRecordedArgs {
  personId: ContactPersonId;
  purpose: ConsentPurpose;
  /** A short code (B4 owns the list), e.g. "verbal". */
  how: string;
  note: string | null;
  /** The team member's user id, never an address. */
  recordedBy: string;
  agreedAt: string | null;
  at: string;
  actor: EventActor;
  key?: string;
}

/** A person's consent to one purpose, granted. Withdrawal is piece F's. */
export function consentRecordedEvent(a: ConsentRecordedArgs): EventWrite {
  const at = canonical(a.at);
  return checked({
    key: a.key ?? `consent|${a.personId}|${a.purpose}|${at}`,
    kind: "consent.recorded",
    at,
    subject: { type: "person", id: a.personId },
    personId: a.personId,
    source: { system: "app" },
    actor: a.actor,
    properties: { purpose: a.purpose, state: "granted", how: a.how, note: a.note, recordedBy: a.recordedBy, agreedAt: a.agreedAt },
  });
}
