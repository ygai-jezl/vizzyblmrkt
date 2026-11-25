import type { TenantContext } from "@/lib/tenant/types";
import type { EmailEvent, EmailEventType } from "@/lib/types/emailEvent";
import type { ProductEvent } from "@/lib/types/productEvent";
import type { PersonMove } from "@/lib/types/personMove";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import type { AgentActionId, AgentActionState, DeclineReason, DeclineWhy } from "@/lib/types/agentAction";
import type { WorkLogRow, WorkWho } from "@/lib/work/types";
import { isContactPersonId, type ContactPersonId } from "./person";

/**
 * The event envelope: one shape for everything that happens, whatever store it came from, so
 * timelines, idea comparisons, journeys, metrics and Vizzy read events the same way. Each source
 * keeps its detail in its own store; the envelope is how they are read together.
 *
 * Pure: mappers from today's rows, the kinds, and the shapes of the event history
 * (ontology_events) and its agent actions. Nothing here writes, and nothing here needs Node, so
 * client components can import it.
 */

/**
 * Every kind of event, as `family.what`. The organisation's plan owns `plan.*` (pieces A and H),
 * so a person's plan is `person_plan.*`.
 */
export const EVENT_KINDS = [
  // Email, from email_events and email_sends.
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.soft_bounced",
  "email.complained",
  "email.rejected",
  "email.unsubscribed",
  // A connected product's messages about its users, from product_events.
  "product.identified",
  "product.tracked",
  "product.erased",
  // Journeys, from enrolments.
  "journey.entered",
  "journey.completed",
  "journey.exited",
  // A launch's waitlist.
  "signup.joined",
  "signup.confirmed",
  "signup.referred",
  "signup.invited",
  "signup.left",
  // A plan for one person.
  "person_plan.drafted",
  "person_plan.approved",
  // Someone engaging with the brand's social posts.
  "social.engaged",
  // Records: one was created, or one of its fields changed (with its value before and after).
  // A pu: person gained an address and joined another (merged), or a product user's address
  // changed or went, so their rows moved to another person (repointed).
  "record.created",
  "record.field_changed",
  "record.merged",
  "record.repointed",
  // A person agreed to (or, later, withdrew from) one purpose (src/lib/ontology/consent.ts).
  "consent.recorded",
  // What an agent proposed, who approved it, what it did, its undo, and a suggestion turned down
  // (dismissed, expired, stale or superseded: the reason says which).
  "agent.proposed",
  "agent.approved",
  "agent.acted",
  "agent.undone",
  "agent.declined",
  // Work (ADR-0018), mapped from work_log rows by fromWorkLog, never stored as events: a task added
  // (with its origin's kind) or changed (with its value before and after), a log entry, a check
  // marked or read (with the measure's kind and the read), and a decision (saying when it approves a
  // plan).
  "work.task_added",
  "work.task_changed",
  "work.logged",
  "work.checked",
  "work.decided",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

/** How we knew who it was: ids only, never an address. */
export interface EventIdentity {
  signupId?: string;
  productUserId?: string;
  connectionId?: string;
}

export const EVENT_SOURCE_SYSTEMS = ["app", "mandrill", "connect", "social", "agent"] as const;
export type EventSourceSystem = (typeof EVENT_SOURCE_SYSTEMS)[number];
export const EVENT_ACTOR_TYPES = ["person", "member", "agent", "product", "system"] as const;
export type EventActorType = (typeof EVENT_ACTOR_TYPES)[number];

export interface OntologyEvent<K extends EventKind = EventKind> {
  /** Stable, so a replay counts once. */
  id: string;
  kind: K;
  /** When it happened, ISO 8601. */
  at: string;
  /** The person it is about, or null when there is none or it isn't known yet. */
  person: ContactPersonId | null;
  identity: EventIdentity | null;
  /** The idea (a launch's campaign id today) it is credited to, if any. */
  ideaCredited: string | null;
  source: { system: EventSourceSystem; connectionId?: string };
  /** Who or what did it. */
  actor: { type: EventActorType; id: string | null };
  /** Ids of what it relates to, such as journeyId, nodeId, enrolmentId, sendId and versionId. */
  refs: Record<string, string>;
  /** The kind's own detail. */
  properties: Record<string, unknown>;
  /**
   * What it is about, when that is more than the person: always set on a stored event
   * (ontology_events), absent on events mapped from other stores.
   */
  subject?: EventSubject;
}

/** Who or what did it: ids only, never an address. */
export type EventActor = OntologyEvent["actor"];

/** Every email event type, as an event kind. */
export const EMAIL_EVENT_KIND: Record<EmailEventType, EventKind> = {
  send: "email.sent",
  open: "email.opened",
  click: "email.clicked",
  bounce: "email.bounced",
  soft_bounce: "email.soft_bounced",
  spam: "email.complained",
  reject: "email.rejected",
  unsub: "email.unsubscribed",
};

/** Every product event type, as an event kind. */
export const PRODUCT_EVENT_KIND: Record<ProductEvent["type"], EventKind> = {
  identify: "product.identified",
  track: "product.tracked",
  erase: "product.erased",
};

/** Email events the person did themselves; the rest are the provider's doing. */
const PERSON_EMAIL_TYPES: ReadonlySet<EmailEventType> = new Set<EmailEventType>(["open", "click", "spam", "unsub"]);

/** The person on a row, when it holds a `ct_` id. */
function personOn(row: { personId?: unknown }): ContactPersonId | null {
  return isContactPersonId(row.personId) ? row.personId : null;
}

/** Only the ids that are set. */
function refsOf(entries: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/**
 * Where a click went, without anything that could name the person: an http(s) address's origin and
 * path only (no query, no fragment, no user), and nothing at all when what is left has an "@".
 */
function linkOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const link = `${parsed.origin}${parsed.pathname}`;
  return link.includes("@") ? null : link;
}

/** An email_events row as an event. The person comes from the row's personId, or is null. */
export function fromEmailEvent(row: Omit<EmailEvent, "personId"> & { personId?: string | null }): OntologyEvent {
  const person = personOn(row);
  const isProductUser = row.recipientKind === "product_user";
  const connectionId = row.connectionId ?? undefined;
  const identity: EventIdentity | null = row.signupId
    ? isProductUser
      ? { productUserId: row.signupId, ...(connectionId ? { connectionId } : {}) }
      : { signupId: row.signupId }
    : null;
  const link = row.type === "click" ? linkOf(row.url) : null;
  return {
    id: row.id,
    kind: EMAIL_EVENT_KIND[row.type],
    at: row.ts || row.createdAt,
    person,
    identity,
    ideaCredited: row.campaignId || null,
    source: { system: "mandrill", ...(isProductUser && connectionId ? { connectionId } : {}) },
    actor: PERSON_EMAIL_TYPES.has(row.type) ? { type: "person", id: person } : { type: "system", id: null },
    refs: refsOf({ journeyId: row.journeyId, nodeId: row.nodeId, enrolmentId: row.enrolmentId }),
    properties: { variantId: row.variantId, ...(link ? { link } : {}) },
  };
}

/**
 * A product_events row as an event. The person comes from the row's personId, or is null; an
 * erase never names one. The product's payload and its own user id stay out: they can hold an
 * address.
 */
export function fromProductEvent(row: Omit<ProductEvent, "personId"> & { personId?: string | null }): OntologyEvent {
  const erased = row.type === "erase";
  return {
    id: row.id,
    kind: PRODUCT_EVENT_KIND[row.type],
    at: row.timestamp || row.receivedAt,
    person: erased ? null : personOn(row),
    identity: erased ? { connectionId: row.connectionId } : { productUserId: row.productUserId, connectionId: row.connectionId },
    ideaCredited: null,
    source: { system: "connect", connectionId: row.connectionId },
    actor: { type: "product", id: row.connectionId },
    refs: refsOf({ entityId: row.entityId }),
    properties: {
      ...(row.type === "track" && row.event ? { event: row.event } : {}),
      applied: row.applied,
      ...(row.skipped ? { skipped: row.skipped } : {}),
    },
  };
}

/**
 * A person_moves row as an event: a product user merged into, or repointed to, another person. The
 * person is the one they moved to; the one they left is in the properties. Ids only.
 */
export function fromPersonMove(row: Omit<PersonMove, "personId" | "fromPersonId"> & { personId?: string | null; fromPersonId?: string | null }): OntologyEvent {
  return {
    id: row.id,
    kind: row.kind,
    at: row.at,
    person: personOn(row),
    identity: { productUserId: row.productUserId, connectionId: row.connectionId },
    ideaCredited: null,
    source: { system: "connect", connectionId: row.connectionId },
    actor: { type: "product", id: row.connectionId },
    refs: {},
    properties: { fromPersonId: isContactPersonId(row.fromPersonId) ? row.fromPersonId : null, repoint: row.repoint },
  };
}

/** Who did a Work row, as an event's actor: a member, Vizzy or a coding agent (agents), or the system. */
function workActor(who: WorkWho): OntologyEvent["actor"] {
  if (who.kind === "person") return { type: "member", id: who.id };
  if (who.kind === "vizzy") return { type: "agent", id: "vizzy" };
  if (who.kind === "coding_agent") return { type: "agent", id: who.id };
  return { type: "system", id: who.id };
}

/** Where a Work change came from, in record.field_changed's words. */
function workChangeSource(row: Pick<WorkLogRow, "source">): FieldChangeSource {
  if (row.source.who.kind === "vizzy" || row.source.who.kind === "coding_agent") return "agent";
  if (row.source.who.kind === "system") return "sync";
  return row.source.tool === "import" ? "import" : "editor";
}

/**
 * A work_log row as an event, so the loops read Work as they read everything else (ADR-0018). It
 * names no person (Work is the team's, never a brand's people); the task, brand and organisation
 * are in refs. A change row is shaped like record.field_changed ({field, before, after, source});
 * the task's first change row ("added") is work.task_added with its origin's kind. A check row
 * carries the measure's kind, which measure and the read; a decision says whether it approves a
 * plan and whether the choice took the recommended pick. Words people wrote (an entry's note, a
 * decision's question) stay on the row.
 */
export function fromWorkLog(row: WorkLogRow): OntologyEvent {
  const base = {
    id: row.id,
    at: row.at,
    person: null,
    identity: null,
    ideaCredited: null,
    source: { system: row.source.who.kind === "person" || row.source.who.kind === "system" ? ("app" as const) : ("agent" as const) },
    actor: workActor(row.source.who),
    refs: refsOf({ organisationId: row.organisationId, brandId: row.brandId, taskId: row.taskId }),
  };
  switch (row.kind) {
    case "entry":
      return { ...base, kind: "work.logged", properties: { workstream: row.workstream, state: row.state, tool: row.source.tool } };
    case "change": {
      if (row.field === "added") {
        const after = (row.after ?? {}) as { origin?: unknown; ref?: unknown };
        return { ...base, kind: "work.task_added", properties: { origin: typeof after.origin === "string" ? after.origin : null, ref: typeof after.ref === "number" ? after.ref : null, tool: row.source.tool } };
      }
      return { ...base, kind: "work.task_changed", properties: { field: row.field, before: row.before ?? null, after: row.after ?? null, source: workChangeSource(row) } };
    }
    case "check":
      return {
        ...base,
        kind: "work.checked",
        properties: { action: row.check.action, checkKind: row.check.kind, measureKind: row.check.measureKind, which: row.check.which, read: row.check.read, counted: row.check.counted?.n ?? null },
      };
    case "decision":
      return {
        ...base,
        kind: "work.decided",
        properties: {
          planApproval: row.decision.plan !== null,
          agreed: row.decision.agreed,
          chosen: row.decision.chosen?.option ?? null,
          recommendedBy: row.decision.recommended?.by.kind ?? null,
          replaces: row.decision.replaces,
        },
      };
    default: {
      const unknown: never = row;
      throw new Error(`unknown_work_log_kind:${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

/**
 * Who acted, from how the request was established (TenantContext.source): an agent for the member
 * whose chat it runs in, a signed in member, a connected product's key, the person themselves on a
 * public page (a sign-up is made by the person), or the system.
 */
export function actorOf(ctx: Pick<TenantContext, "source" | "userId">, person?: ContactPersonId | null): OntologyEvent["actor"] {
  switch (ctx.source) {
    case "agent":
      return { type: "agent", id: ctx.userId ?? null };
    case "idtoken":
      return { type: "member", id: ctx.userId ?? null };
    case "api_key":
      return { type: "product", id: null };
    case "host":
    case "tenant_param":
      return { type: "person", id: person ?? null };
    case "system":
      return { type: "system", id: null };
    default: {
      const unknown: never = ctx.source;
      throw new Error(`unknown_context_source:${String(unknown)}`);
    }
  }
}

/** The kinds an agent action's trail is made of. */
export type AgentEventKind = Extract<EventKind, `agent.${string}`>;

/** Whether a kind is a step of an agent action's trail. */
export function isAgentEventKind(kind: string): kind is AgentEventKind {
  return kind.startsWith("agent.") && isEventKind(kind);
}

export interface AgentActionProperties {
  /** The agent action (agent_actions) this step belongs to. */
  agentActionId: AgentActionId;
  /** Which agent, e.g. "vizzy". */
  agent: string;
  /** What it does, e.g. "person_fields.suggest". */
  action: string;
  /** What it acts on: a person, company or idea, each a type in src/lib/ontology/registry.ts. */
  target: AgentTarget;
  /** The action's state after this step. */
  state: AgentActionState;
  /** Why it was declined, on agent.declined. */
  reason?: DeclineReason;
  /** Why a person dismissed it, when they said, on agent.declined with reason dismissed. */
  why?: DeclineWhy;
  /** The draft it made, when it made one. */
  draft?: { kind: string; ref: string };
  /** The limit it acted within, when it acted on its own. */
  within?: string;
  /** The event this one undoes. */
  undoes?: string;
}

/** One step of an agent action's trail, kept in ontology_events (src/lib/tenant/agentActions.ts writes it). */
export type AgentActionEvent = OntologyEvent<AgentEventKind> & { properties: AgentActionProperties };

// --- Stored events: the event history (ontology_events) ---------------------------------------

/**
 * What a stored event is about. A person's timeline is every row whose personId is theirs, which
 * also covers rows about something else (an agent action about them). A later object type (the
 * brand's own objects) widens this list and adds its registry type.
 */
export const SUBJECT_TYPES = ["person", "company", "idea", "agent_action"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export interface EventSubject {
  type: SubjectType;
  /** A `ct_` person id, a `co_` company id, a launch's campaign id or an `aa_` agent action id. */
  id: string;
}

/** `type:id`, as stored on each row so one subject's history is one equality query. */
export type SubjectKey = `${SubjectType}:${string}`;

/** A subject's id: letters, digits, `_`, `.` and `-`, so it fits in an event key. Never an address. */
export const SUBJECT_ID = /^[A-Za-z0-9_.-]{1,200}$/;

export function subjectKey(s: EventSubject): SubjectKey {
  return `${s.type}:${s.id}`;
}

/** The subject a key names, or null for anything else (an unknown type, no id, a bad id). */
export function parseSubjectKey(k: string): EventSubject | null {
  if (typeof k !== "string") return null;
  const at = k.indexOf(":");
  if (at <= 0) return null;
  const type = k.slice(0, at);
  const id = k.slice(at + 1);
  if (!(SUBJECT_TYPES as readonly string[]).includes(type) || !SUBJECT_ID.test(id)) return null;
  return { type: type as SubjectType, id };
}

/** Each subject type's type in the ontology registry (src/lib/ontology/registry.ts). */
export const SUBJECT_TYPE_REGISTRY_ID: Record<SubjectType, string> = {
  person: "person",
  company: "company",
  idea: "idea",
  agent_action: "agent_action",
};

/**
 * What an agent action can be about. A consumer that needs another target adds the value and its
 * registry type id in its own change.
 */
export const AGENT_TARGET_TYPES = ["person", "company", "idea", "data_signal", "brand_question", "brand"] as const;
export type AgentTargetType = (typeof AGENT_TARGET_TYPES)[number];

export interface AgentTarget {
  type: AgentTargetType;
  id: string;
}

/** Each target type's type in the ontology registry. */
export const AGENT_TARGET_REGISTRY_ID: Record<AgentTargetType, string> = {
  person: "person",
  company: "company",
  idea: "idea",
  // What collected numbers suggest (Connectors 2 group 4): a Review suggestion, and a question it
  // proposed on the brand map.
  data_signal: "data_signal",
  brand_question: "brand_question",
  // Something Vizzy heard about the business in a chat, waiting for an admin to keep it in About
  // your business (ONBOARDING_ENABLED, src/lib/onboarding/factSuggestions.ts). The id is the brand's.
  brand: "brand",
};

/**
 * The kinds the event history keeps: what has no other home. Email, product, journey and sign-up
 * moments stay in their own stores and are read beside it; merges and repoints stay in
 * person_moves. The writers refuse any other kind.
 */
export const STORED_EVENT_KINDS = [
  "record.created",
  "record.field_changed",
  "consent.recorded",
  "agent.proposed",
  "agent.approved",
  "agent.acted",
  "agent.undone",
  "agent.declined",
] as const satisfies readonly EventKind[];
export type StoredEventKind = (typeof STORED_EVENT_KINDS)[number];

export function isStoredEventKind(value: unknown): value is StoredEventKind {
  return typeof value === "string" && (STORED_EVENT_KINDS as readonly string[]).includes(value);
}

/** Where a field's new value came from. */
export const FIELD_CHANGE_SOURCES = ["editor", "agent", "import", "sync", "restore", "undo"] as const;
export type FieldChangeSource = (typeof FIELD_CHANGE_SOURCES)[number];

/** The records whose fields change, and that are created, with an event. */
export const FIELD_OBJECTS = ["person", "company", "idea"] as const;
export type FieldObject = (typeof FIELD_OBJECTS)[number];

/** record.field_changed: one field's value before and after. The values may be personal. */
export interface FieldChangedProperties {
  fieldId: string;
  object: FieldObject;
  before: unknown;
  after: unknown;
  source: FieldChangeSource;
}

/** record.created: what was created, and how (for example "form", "palette" or "vizzy"). */
export interface RecordCreatedProperties {
  object: FieldObject;
  via: string;
}

/**
 * A field the brand defines: letters, digits, `_` and `-`, so a dotted update path such as
 * `proposal.fields.<id>` is always safe. Never a system field id.
 */
export const USER_FIELD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** System field ids (a stage, a tag, an idea's status) start with this, and never clash with the brand's own. */
export const SYSTEM_FIELD_PREFIX = "sys.";
const SYSTEM_FIELD_PART = /^[A-Za-z0-9_-]+$/;

/** A system field id from its parts, e.g. systemFieldId("stage", connectionId) is `sys.stage.<connectionId>`. */
export function systemFieldId(...parts: string[]): string {
  if (parts.length === 0 || parts.some((p) => typeof p !== "string" || !SYSTEM_FIELD_PART.test(p))) {
    throw new Error("bad_system_field_id");
  }
  return `${SYSTEM_FIELD_PREFIX}${parts.join(".")}`;
}

export function isSystemFieldId(id: string): boolean {
  if (typeof id !== "string" || !id.startsWith(SYSTEM_FIELD_PREFIX) || id.length > 200) return false;
  return id.slice(SYSTEM_FIELD_PREFIX.length).split(".").every((p) => SYSTEM_FIELD_PART.test(p));
}

export function isUserFieldId(id: string): boolean {
  return typeof id === "string" && USER_FIELD_ID.test(id);
}

/**
 * The one form a stored time takes: what toISOString gives, with milliseconds and Z, so string
 * order is time order.
 */
export const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** A value's size as UTF-8 JSON, measured with TextEncoder (no Buffer: this can reach the browser). */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/**
 * A stored event as an envelope: the person from its personId, and its subject kept. Ids only;
 * properties are the kind's own detail (a field change holds its values before and after).
 */
export function fromStoredEvent(row: StoredEvent): OntologyEvent {
  return {
    id: row.id,
    kind: row.kind,
    at: row.at,
    person: isContactPersonId(row.personId) ? row.personId : null,
    identity: row.identity ?? null,
    ideaCredited: row.ideaCredited ?? null,
    source: row.source,
    actor: row.actor,
    refs: row.refs ?? {},
    properties: row.properties,
    subject: row.subject,
  };
}
