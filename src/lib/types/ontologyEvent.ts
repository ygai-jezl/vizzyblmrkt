import { z } from "zod";
import {
  CANONICAL_INSTANT,
  EVENT_SOURCE_SYSTEMS,
  FIELD_CHANGE_SOURCES,
  FIELD_OBJECTS,
  isAgentEventKind,
  isCanonicalInstant,
  isSystemFieldId,
  isUserFieldId,
  jsonBytes,
  STORED_EVENT_KINDS,
  SUBJECT_ID,
  SUBJECT_TYPES,
  subjectKey,
  type EventActor,
  type EventIdentity,
  type EventSubject,
  type OntologyEvent,
  type StoredEventKind,
  type SubjectKey,
} from "@/lib/ontology/events";
import { ConsentRecordedPropertiesSchema } from "@/lib/ontology/consent";
import { ContactPersonIdSchema, type ContactPersonId } from "@/lib/ontology/person";
import { AGENT_ACTION_STATES, AgentActionIdSchema, DECLINE_REASONS, DECLINE_WHY, EventActorSchema, type AgentActionId } from "./agentAction";

/**
 * The event history (ontology_events, the brand's regional database): one row per thing that
 * happened to a subject (a person, company, idea or agent action) that has no other home, plus a
 * personId routing key, so a person's timeline is every row carrying their personId. Append only:
 * written by src/lib/tenant/ontologyEvents.ts and src/lib/tenant/agentActions.ts, and changed
 * only to repoint a person, to blank an erased field's values, or to erase.
 *
 * Pure: zod and plain data only (no node: modules, no Buffer), so client components can import
 * the types.
 */

export { CANONICAL_INSTANT };

export const EVENT_LIMITS = {
  /** Characters in a key. */
  keyChars: 300,
  /** Properties, as UTF-8 JSON. */
  propertiesBytes: 32_768,
  /** Rows one appendEvents call writes. */
  appendBatch: 200,
  /** Rows one writeRecordWithEvents plan writes. */
  recordEvents: 100,
} as const;

/** `ev_` and 40 hex: a hash of the brand and the key (deterministicEventId). */
export type EventId = `ev_${string}`;
export const EVENT_ID = /^ev_[0-9a-f]{40}$/;

/** An event's key: what makes a write idempotent. Never an address or a spaced name. */
export const EVENT_KEY = /^[A-Za-z0-9_.:|-]{1,300}$/;

/** An id on a row (a product user, a campaign, a connection): no address, no spaces. */
const PLAIN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const noAt = (v: string) => !v.includes("@");

export interface EventWrite {
  key: string;
  kind: StoredEventKind;
  /** Canonical ISO with milliseconds and Z. */
  at: string;
  subject: EventSubject;
  /** The person it is about: equals subject.id for a person subject. */
  personId: ContactPersonId | null;
  /** Only on rows about one product user's own data. */
  productUserId?: string | null;
  /** record.field_changed only: equals properties.fieldId. */
  fieldId?: string | null;
  agentActionId?: AgentActionId | null;
  identity?: EventIdentity | null;
  ideaCredited?: string | null;
  source: OntologyEvent["source"];
  actor: EventActor;
  /** Ids only. */
  refs?: Record<string, string> | null;
  /** The kind's own detail: at most 32 KB as UTF-8 JSON. */
  properties: Record<string, unknown>;
}

/** A row as stored: absent optionals are null, so `blankedAt == null` is queryable. */
export interface StoredEvent extends EventWrite {
  id: EventId;
  tenantId: string;
  subjectKey: SubjectKey;
  productUserId: string | null;
  fieldId: string | null;
  agentActionId: AgentActionId | null;
  identity: EventIdentity | null;
  ideaCredited: string | null;
  refs: Record<string, string> | null;
  createdAt: string;
  blankedAt: string | null;
  blankedReason: "field_erased" | null;
}

const Canonical = z.string().refine(isCanonicalInstant, { message: "not a canonical instant (toISOString)" });
const IdValue = z.string().max(200).refine(noAt, { message: "an id, never an address" });

const IdentitySchema = z.object({
  signupId: IdValue.optional(),
  productUserId: IdValue.optional(),
  connectionId: IdValue.optional(),
});

const FieldChangedPropertiesSchema = z.object({
  fieldId: z.string(),
  object: z.enum(FIELD_OBJECTS),
  before: z.unknown(),
  after: z.unknown(),
  source: z.enum(FIELD_CHANGE_SOURCES),
});

const RecordCreatedPropertiesSchema = z.object({
  object: z.enum(FIELD_OBJECTS),
  via: z.string().regex(/^[a-z_]{1,40}$/),
  /** Where a pasted list came from (RAISE_PASTE_ENABLED). */
  source: z.string().max(80).optional(),
});

const AgentPropertiesSchema = z.object({
  agentActionId: AgentActionIdSchema,
  agent: z.string().regex(/^[a-z_]{1,40}$/),
  action: z.string().max(60),
  state: z.enum(AGENT_ACTION_STATES),
  reason: z.enum(DECLINE_REASONS).optional(),
  why: z.enum(DECLINE_WHY).optional(),
});

const writeShape = {
  key: z.string().regex(EVENT_KEY),
  kind: z.enum(STORED_EVENT_KINDS),
  at: Canonical,
  subject: z.object({ type: z.enum(SUBJECT_TYPES), id: z.string().regex(SUBJECT_ID) }),
  personId: ContactPersonIdSchema.nullable(),
  productUserId: z.string().regex(PLAIN_ID).nullable().optional(),
  fieldId: z.string().max(200).nullable().optional(),
  agentActionId: AgentActionIdSchema.nullable().optional(),
  identity: IdentitySchema.nullable().optional(),
  ideaCredited: z.string().regex(SUBJECT_ID).nullable().optional(),
  source: z.object({ system: z.enum(EVENT_SOURCE_SYSTEMS), connectionId: IdValue.optional() }),
  actor: EventActorSchema,
  refs: z.record(z.string(), IdValue).nullable().optional(),
  properties: z.record(z.string(), z.unknown()),
};

type Ctx = z.RefinementCtx;
type WriteLike = z.infer<z.ZodObject<typeof writeShape>>;

/** The rules every write keeps, beyond each field's own shape. */
function checkWrite(w: WriteLike, c: Ctx): void {
  const issue = (path: (string | number)[], message: string) => c.addIssue({ code: "custom", path, message });
  if (w.subject.type === "person" && w.personId !== w.subject.id) issue(["personId"], "a person subject's personId is its id");
  if (w.kind === "record.field_changed") {
    const props = FieldChangedPropertiesSchema.safeParse(w.properties);
    if (!props.success) issue(["properties"], "record.field_changed needs fieldId, object, before, after and source");
    if (!w.fieldId) issue(["fieldId"], "record.field_changed needs a fieldId");
    else {
      if (!isUserFieldId(w.fieldId) && !isSystemFieldId(w.fieldId)) issue(["fieldId"], "a field id is a user field id or a sys. id");
      if (w.properties.fieldId !== w.fieldId) issue(["fieldId"], "fieldId must equal properties.fieldId");
    }
  } else if (w.fieldId != null) {
    issue(["fieldId"], "only record.field_changed carries a fieldId");
  }
  if (w.kind === "record.created" && !RecordCreatedPropertiesSchema.safeParse(w.properties).success) {
    issue(["properties"], "record.created needs object and via");
  }
  if (w.kind === "consent.recorded") {
    if (w.subject.type !== "person") issue(["subject"], "consent is recorded on a person");
    if (!ConsentRecordedPropertiesSchema.safeParse(w.properties).success) issue(["properties"], "consent.recorded needs purpose, state, how, note, recordedBy and agreedAt");
  }
  if (isAgentEventKind(w.kind)) {
    if (!w.agentActionId) issue(["agentActionId"], "an agent.* row names its agent action");
    else if (w.subject.type !== "agent_action" || w.subject.id !== w.agentActionId) issue(["subject"], "an agent.* row's subject is its agent action");
    const props = AgentPropertiesSchema.safeParse(w.properties);
    if (!props.success || props.data.agentActionId !== w.agentActionId) issue(["properties"], "an agent.* row needs agentActionId, agent, action and state");
  }
  if (jsonBytes(w.properties) > EVENT_LIMITS.propertiesBytes) issue(["properties"], `over ${EVENT_LIMITS.propertiesBytes} bytes`);
}

/** A write, as builders make it and writers check it again. */
export const EventWriteSchema = z.object(writeShape).superRefine(checkWrite);

/** A stored row, as the timeline reads it back: rows that fail are dropped with a count. */
export const StoredEventSchema = z
  .object({
    ...writeShape,
    id: z.string().regex(EVENT_ID),
    tenantId: z.string().min(1),
    subjectKey: z.string(),
    productUserId: z.string().regex(PLAIN_ID).nullable(),
    fieldId: z.string().max(200).nullable(),
    agentActionId: AgentActionIdSchema.nullable(),
    identity: IdentitySchema.nullable(),
    ideaCredited: z.string().regex(SUBJECT_ID).nullable(),
    refs: z.record(z.string(), IdValue).nullable(),
    createdAt: Canonical,
    blankedAt: Canonical.nullable(),
    blankedReason: z.literal("field_erased").nullable(),
  })
  .superRefine((row, c) => {
    checkWrite(row, c);
    // A blanked field change keeps its kind, time, actor and field id; only its values are gone.
    if (row.blankedAt != null && row.kind !== "record.field_changed") c.addIssue({ code: "custom", path: ["blankedAt"], message: "only a field change is blanked" });
    if (row.subjectKey !== subjectKey(row.subject)) c.addIssue({ code: "custom", path: ["subjectKey"], message: "subjectKey must be type:id of the subject" });
    if ((row.blankedAt == null) !== (row.blankedReason == null)) c.addIssue({ code: "custom", path: ["blankedReason"], message: "blankedAt and blankedReason go together" });
  });
