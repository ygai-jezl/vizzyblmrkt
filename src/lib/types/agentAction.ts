import { z } from "zod";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import type { ReviewKind } from "@/lib/review/summary";
import {
  AGENT_TARGET_TYPES,
  CANONICAL_INSTANT,
  EVENT_ACTOR_TYPES,
  isCanonicalInstant,
  jsonBytes,
  SUBJECT_ID,
  USER_FIELD_ID,
  type AgentTarget,
  type EventActor,
} from "@/lib/ontology/events";
import { ContactPersonIdSchema, type ContactPersonId } from "@/lib/ontology/person";

/**
 * Agent actions (agent_actions, the brand's regional database): one record per suggestion an agent
 * makes, with its state and who decided. Its trail is the agent.* rows in ontology_events, written
 * in the same transaction by src/lib/tenant/agentActions.ts, the only writer.
 *
 * Mode is "suggest" only: acting within limits is a later piece with its own switch. Every action
 * expires within 90 days. Field values inside proposal, basis and result sit under `fields`, and
 * inside undo under `before`, keyed by field id, so an erased field can be blanked in place.
 * Signals are references with meaning keys, never free text.
 *
 * Pure: zod and plain data only (no node: modules, no Buffer), so client components can import it.
 */

// --- Ids ---------------------------------------------------------------------------------------

/** `aa_` and 40 hex: a hash of the brand and the dedupe key (deterministicAgentActionId). */
export type AgentActionId = `aa_${string}`;
export const AGENT_ACTION_ID = /^aa_[0-9a-f]{40}$/;

export function isAgentActionId(v: unknown): v is AgentActionId {
  return typeof v === "string" && AGENT_ACTION_ID.test(v);
}

export const AgentActionIdSchema = z.custom<AgentActionId>((v) => isAgentActionId(v), { message: "not_an_agent_action_id" });

// --- States ------------------------------------------------------------------------------------

export const AGENT_ACTION_STATES = ["proposed", "approved", "acted", "undone", "declined"] as const;
export type AgentActionState = (typeof AGENT_ACTION_STATES)[number];

/** The moves each state allows. Undone and declined are final. */
export const AGENT_TRANSITIONS: Readonly<Record<AgentActionState, readonly AgentActionState[]>> = {
  proposed: ["approved", "acted", "declined"],
  approved: ["acted", "declined"],
  acted: ["undone"],
  undone: [],
  declined: [],
};

export function canTransition(from: AgentActionState, to: AgentActionState): boolean {
  return (AGENT_TRANSITIONS[from] ?? []).includes(to);
}

/** The states that end a suggestion, where clearDetailsOnClose clears proposal and basis. */
export const TERMINAL_FOR_DETAILS = ["acted", "declined"] as const satisfies readonly AgentActionState[];

/** Why a suggestion was declined. Expiry, staleness and being superseded are all declines. */
export const DECLINE_REASONS = ["dismissed", "expired", "stale", "superseded"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/**
 * Why a person dismissed a suggestion, one tap beside the mechanical reason (only with
 * "dismissed"): Not now, Not for us, Already on it or Wrong. Optional: No reason still dismisses.
 * One shared list: Work brings these four, and the learning loops add their own here later.
 */
export const DECLINE_WHY = ["not_now", "not_for_us", "already_on_it", "wrong"] as const;
export type DeclineWhy = (typeof DECLINE_WHY)[number];

/**
 * The agents that propose. "lifecycle" is for the AI lines follow-up. "research" is brand map
 * research and learning from a repo, whoever pressed it (the record's requestedBy says who; agent
 * record, ADR-0026). "raise_followups" is YouGrow's follow-up rule on the investor and funding board.
 * "paste" is the code that reads a list pasted on People into one card (RAISE_PASTE_ENABLED), as
 * "connector_signals" reads collected numbers.
 */
export const AGENT_NAMES = ["vizzy", "autopilot", "connector_signals", "lifecycle", "research", "raise_followups", "paste"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

// --- Signals -----------------------------------------------------------------------------------

/**
 * What a suggestion was based on, by kind of source. "work_log" and "work_task" are the Work rows
 * Vizzy read (ADR-0020): a log row's or a task's id, checked against the organisation.
 */
export const SIGNAL_KINDS = [
  "field_value",
  "product_event",
  "email_event",
  "product_user",
  "data_signal",
  "brand_signal",
  "metric",
  "brand_map",
  "brand_note",
  "search_doc",
  "work_log",
  "work_task",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** A signal's ref: an id, never free text. */
export const SIGNAL_REF = /^[A-Za-z0-9_.:|-]{1,200}$/;

export interface SignalRef {
  kind: SignalKind;
  ref: string;
  meaning?: MeaningKey;
  /** Never on a "field_value" signal: its value lives under basis.fields. */
  value?: number | null;
  at?: string;
}

const MEANING_KEYS = Object.keys(MEANINGS) as [MeaningKey, ...MeaningKey[]];

export const SignalRefSchema = z
  .object({
    kind: z.enum(SIGNAL_KINDS),
    ref: z.string().regex(SIGNAL_REF),
    meaning: z.enum(MEANING_KEYS).optional(),
    value: z.number().finite().nullable().optional(),
    at: z.string().regex(CANONICAL_INSTANT).optional(),
  })
  .superRefine((s, c) => {
    if (s.kind === "field_value" && s.value != null) {
      c.addIssue({ code: "custom", path: ["value"], message: "a field_value signal carries no value: it lives under basis.fields" });
    }
  });

// --- Limits and keys ---------------------------------------------------------------------------

/** Field values inside proposal, basis and result live under this key, by field id. */
export const FIELD_VALUES_KEY = "fields";

export const AGENT_ACTION_LIMITS = {
  proposalBytes: 65_536,
  basisBytes: 65_536,
  resultBytes: 65_536,
  undoBytes: 65_536,
  signals: 20,
  fieldIds: 100,
  maxExpiryDays: 90,
} as const;

/** What an agent does, as `area.verb`, e.g. "person_fields.suggest". */
export const AGENT_ACTION_NAME = /^[a-z_]+\.[a-z_]+$/;
/** A dedupe key, as stored: the same characters as an event key. */
export const DEDUPE_KEY = /^[A-Za-z0-9_.:|-]{1,300}$/;
const DEDUPE_PART = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * A dedupe key: the action and its parts joined with "|". A key names one suggestion: proposing it
 * again answers "open" or "decided" and writes nothing. Patterns:
 * - a request or detection id, for a one off suggestion (B6b: the chat request id);
 * - a content hash, for "never suggest this exact thing again" (B6a: the field and a hash of the
 *   suggested value);
 * - a time bucket such as the ISO week, for "at most once a week after a dismissal" (2d).
 * Never an address or a name: hash anything that could hold one, or spaces (2d's topic keys).
 */
export function agentDedupeKey(action: string, ...parts: string[]): string {
  if (typeof action !== "string" || action.length > 60 || !AGENT_ACTION_NAME.test(action)) throw new Error("bad_agent_action");
  if (parts.some((p) => typeof p !== "string" || !DEDUPE_PART.test(p))) throw new Error("bad_dedupe_key_part");
  const key = [action, ...parts].join("|");
  if (key.length > 300) throw new Error("dedupe_key_too_long");
  return key;
}

// --- The record --------------------------------------------------------------------------------

/** An id of a product user, a draft or another record: no address, no spaces. */
const PLAIN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const noAt = (v: string) => !v.includes("@");

/** Who or what did it, with ids only. */
export const EventActorSchema = z.object({
  type: z.enum(EVENT_ACTOR_TYPES),
  id: z.string().max(200).refine(noAt, { message: "an id, never an address" }).nullable(),
});

const Canonical = z.string().refine(isCanonicalInstant, { message: "not a canonical instant (toISOString)" });
const Details = z.record(z.string(), z.unknown());

export interface AgentAction {
  id: AgentActionId;
  tenantId: string;
  dedupeKey: string;
  agent: AgentName;
  action: string;
  mode: "suggest";
  target: AgentTarget;
  /** `type:id`, the subject key shape, so a company's or an idea's erase finds its actions. */
  targetKey: string;
  /** Equals target.id for a person target. */
  personId: ContactPersonId | null;
  /** Only when the suggestion is about one product user's own data; null for a person target. */
  productUserId: string | null;
  state: AgentActionState;
  rev: number;
  proposal: Record<string, unknown> | null;
  basis: Record<string, unknown> | null;
  /** The field ids whose values it holds and that are still to blank, each a USER_FIELD_ID. */
  fieldIds: string[];
  signals: SignalRef[];
  draft: { kind: string; ref: string } | null;
  review: { kind: ReviewKind; href: string } | null;
  requestedBy: EventActor;
  decidedBy: EventActor | null;
  decidedAt: string | null;
  actedBy: EventActor | null;
  actedAt: string | null;
  result: Record<string, unknown> | null;
  undo: { before: Record<string, unknown> } | null;
  undoneBy: EventActor | null;
  undoneAt: string | null;
  /** Why it was declined, and for a person's dismissal, the reason they tapped (if any). */
  declined: { reason: DeclineReason; why?: DeclineWhy } | null;
  /** Required, after createdAt and at most 90 days on. */
  expiresAt: string;
  clearDetailsOnClose: boolean;
  detailsClearedAt: string | null;
  /** Field ids already blanked after an erase. */
  blankedFieldIds: string[];
  createdAt: string;
  updatedAt: string;
}

const DAY_MS = 86_400_000;

export const AgentActionSchema = z
  .object({
    id: AgentActionIdSchema,
    tenantId: z.string().min(1),
    dedupeKey: z.string().regex(DEDUPE_KEY),
    agent: z.enum(AGENT_NAMES),
    action: z.string().max(60).regex(AGENT_ACTION_NAME),
    mode: z.literal("suggest"),
    target: z.object({ type: z.enum(AGENT_TARGET_TYPES), id: z.string().regex(SUBJECT_ID) }),
    targetKey: z.string(),
    personId: ContactPersonIdSchema.nullable(),
    productUserId: z.string().regex(PLAIN_ID).nullable(),
    state: z.enum(AGENT_ACTION_STATES),
    rev: z.number().int().min(1),
    proposal: Details.nullable(),
    basis: Details.nullable(),
    fieldIds: z.array(z.string().regex(USER_FIELD_ID)).max(AGENT_ACTION_LIMITS.fieldIds),
    signals: z.array(SignalRefSchema).max(AGENT_ACTION_LIMITS.signals),
    draft: z.object({ kind: z.string().regex(/^[a-z_]{1,40}$/), ref: z.string().regex(PLAIN_ID) }).nullable(),
    // A Review kind (src/lib/review/summary.ts) and an in-app link.
    review: z
      .object({ kind: z.string().regex(/^[a-z_]{1,40}$/), href: z.string().max(500).regex(/^\/[^\s]*$/) })
      .nullable() as z.ZodType<{ kind: ReviewKind; href: string } | null>,
    requestedBy: EventActorSchema,
    decidedBy: EventActorSchema.nullable(),
    decidedAt: Canonical.nullable(),
    actedBy: EventActorSchema.nullable(),
    actedAt: Canonical.nullable(),
    result: Details.nullable(),
    undo: z.object({ before: Details }).nullable(),
    undoneBy: EventActorSchema.nullable(),
    undoneAt: Canonical.nullable(),
    declined: z.object({ reason: z.enum(DECLINE_REASONS), why: z.enum(DECLINE_WHY).optional() }).nullable(),
    expiresAt: Canonical,
    clearDetailsOnClose: z.boolean(),
    detailsClearedAt: Canonical.nullable(),
    blankedFieldIds: z.array(z.string().regex(USER_FIELD_ID)).max(AGENT_ACTION_LIMITS.fieldIds),
    createdAt: Canonical,
    updatedAt: Canonical,
  })
  .superRefine((a, c) => {
    if (a.targetKey !== `${a.target.type}:${a.target.id}`) c.addIssue({ code: "custom", path: ["targetKey"], message: "targetKey must be type:id of the target" });
    if (a.target.type === "person") {
      if (a.personId !== a.target.id) c.addIssue({ code: "custom", path: ["personId"], message: "a person target's personId is its id" });
      if (a.productUserId !== null) c.addIssue({ code: "custom", path: ["productUserId"], message: "a person target has no product user" });
    }
    const sizes: Array<[keyof typeof a, number]> = [
      ["proposal", AGENT_ACTION_LIMITS.proposalBytes],
      ["basis", AGENT_ACTION_LIMITS.basisBytes],
      ["result", AGENT_ACTION_LIMITS.resultBytes],
      ["undo", AGENT_ACTION_LIMITS.undoBytes],
    ];
    for (const [key, max] of sizes) {
      if (a[key] != null && jsonBytes(a[key]) > max) c.addIssue({ code: "custom", path: [key], message: `over ${max} bytes` });
    }
    const fieldIds = new Set([...a.fieldIds, ...a.blankedFieldIds]);
    a.signals.forEach((s, i) => {
      if (s.kind === "field_value" && !fieldIds.has(s.ref)) {
        c.addIssue({ code: "custom", path: ["signals", i, "ref"], message: "a field_value signal names one of the action's field ids" });
      }
    });
    if (a.declined?.why && a.declined.reason !== "dismissed") c.addIssue({ code: "custom", path: ["declined", "why"], message: "a why goes only with dismissed" });
    if (isCanonicalInstant(a.expiresAt) && isCanonicalInstant(a.createdAt)) {
      const span = Date.parse(a.expiresAt) - Date.parse(a.createdAt);
      if (span <= 0) c.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be after createdAt" });
      if (span > AGENT_ACTION_LIMITS.maxExpiryDays * DAY_MS) c.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt is at most 90 days on" });
    }
  });
