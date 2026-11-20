import type { TenantContext } from "@/lib/tenant/types";
import type { EmailEvent, EmailEventType } from "@/lib/types/emailEvent";
import type { ProductEvent } from "@/lib/types/productEvent";
import { isContactPersonId, type ContactPersonId } from "./person";

/**
 * The event envelope: one shape for everything that happens, whatever store it came from, so
 * timelines, idea comparisons, journeys, metrics and Vizzy read events the same way. Each source
 * keeps its detail in its own store; the envelope is how they are read together.
 *
 * Pure: mappers from today's rows, and the kinds. Nothing here writes.
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
  // Records: a pu: person gained an address and joined another (merged), or a product user's
  // address changed or went, so their rows moved to another person (repointed).
  "record.merged",
  "record.repointed",
  // What an agent proposed, who approved it, what it did and its undo.
  "agent.proposed",
  "agent.approved",
  "agent.acted",
  "agent.undone",
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

export type EventSourceSystem = "app" | "mandrill" | "connect" | "social" | "agent";
export type EventActorType = "person" | "member" | "agent" | "product" | "system";

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
}

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
export function fromEmailEvent(row: EmailEvent & { personId?: string | null }): OntologyEvent {
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
export function fromProductEvent(row: ProductEvent & { personId?: string | null }): OntologyEvent {
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

export interface AgentActionProperties {
  /** Which agent, e.g. "vizzy". */
  agent: string;
  /** What it does, e.g. "draft_article". */
  action: string;
  /** What it acts on: an ontology type id from src/lib/ontology/registry.ts, and that record's id. */
  target: { type: string; id: string };
  /** The draft it made, when it made one. */
  draft?: { kind: string; ref: string };
  /** The limit it acted within, when it acted on its own. */
  within?: string;
  /** The event this one undoes. */
  undoes?: string;
}

/** One step of an agent action's trail. The type only: the store comes later (0e). */
export type AgentActionEvent = OntologyEvent<AgentEventKind> & { properties: AgentActionProperties };
