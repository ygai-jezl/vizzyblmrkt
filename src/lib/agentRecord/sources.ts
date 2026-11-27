import type { CanvasKindName } from "@/lib/canvas/names";
import type { LoopKind } from "@/lib/loops/registry";
import type { ReviewKind } from "@/lib/review/summary";
import type { AgentName } from "@/lib/types/agentAction";

/**
 * Agent record (AGENT_RECORD_ENABLED, ADR-0026): the rules, one line per thing an agent drafts for
 * a brand. Pure data, so tests, the catch-up and Vizzy's read share one list.
 *
 * Each line says what is recorded (its action and agent), what it drafts (the draft's kind, a type
 * in the ontology registry), what the record is about (a launch's drafts target the idea, so
 * deleteLaunch erases them; the rest target the brand), the loop kind that made it, the Review
 * section it waits in, where the loops will count its outcome (`countsAt`), what its fingerprint
 * covers and how the catch-up reads its draft.
 *
 * Records hold ids, a label and a fingerprint only (decision 6): never a draft's words, a note's
 * text, or anyone's name or address.
 */

/** What a record points at: the draft's kind (a store) and its id there. */
export const DRAFT_KINDS = [
  "launch_journey",
  "lifecycle_journey",
  "invite_wave",
  "content_plan",
  "email_style",
  "image_style",
  "brand_map",
  "brand_note",
  "repo_map",
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Each draft kind's type in the ontology registry. A brand's styles live on the brand's record. */
export const DRAFT_TYPE: Readonly<Record<DraftKind, string>> = {
  launch_journey: "launch_journey",
  lifecycle_journey: "lifecycle_journey",
  invite_wave: "invite_wave",
  content_plan: "content_plan",
  email_style: "brand",
  image_style: "brand",
  brand_map: "brand_map",
  brand_note: "brand_note",
  repo_map: "repo_map",
};

/**
 * Where loops step 5 counts a line's outcome: in transitionAgentAction (`transition`), or at the
 * draft's own path (`own_path`), where it already counts approvals, sends and dismissals.
 */
export type CountsAt = "own_path" | "transition";

/** How the catch-up reads a line's draft to see whether it moved on another way. */
export type CatchUpReader = "launch_journey" | "lifecycle_journey" | "invite_wave" | "content_plan" | "brand_style" | "brand_map_run" | "brand_note" | "repo_run";

/** The word Vizzy uses for a kept draft of this kind. */
export type KeptWord = "turned on" | "published" | "sent" | "approved" | "applied" | "kept" | "accepted";

export interface SourceLine {
  /** The kind Vizzy's get_drafts names it by. */
  key: string;
  /** `area.verb`, as stored on the record. */
  action: string;
  agent: AgentName;
  /** The drafts it records, by kind (a launch's welcome emails live in either engine's store). */
  drafts: readonly [DraftKind, ...DraftKind[]];
  /** `idea` when the draft belongs to a launch, else `brand`; `idea_or_brand` when it depends on the draft. */
  target: "idea" | "brand" | "idea_or_brand";
  loop: LoopKind;
  review: ReviewKind;
  countsAt: CountsAt;
  /** What its fingerprint covers, never positions or ids; null when it has none. */
  fingerprint: string | null;
  catchUp: CatchUpReader;
  kept: KeptWord;
  /** Read by admins only through get_drafts: the brand's styles and notes, as on their pages. */
  adminOnly: boolean;
  /** Days a record waits before it expires, at most 90. */
  expiryDays: number;
}

const DAYS = 90;

export const SOURCES = [
  {
    key: "launch_journey",
    action: "launch_journey.draft",
    agent: "vizzy",
    drafts: ["launch_journey", "lifecycle_journey"],
    target: "idea",
    loop: "canvas.journey",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "each email's subject and body, and each wait",
    catchUp: "launch_journey",
    kept: "turned on",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "lifecycle_journey",
    action: "lifecycle_journey.draft",
    agent: "vizzy",
    drafts: ["lifecycle_journey"],
    target: "brand",
    loop: "canvas.lifecycle",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "each email's subject and body, each wait, the start and the journey's own email style",
    catchUp: "lifecycle_journey",
    kept: "published",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "invite_wave",
    action: "invite_wave.draft",
    agent: "vizzy",
    drafts: ["invite_wave"],
    target: "idea",
    loop: "canvas.invite_wave",
    review: "agent_draft",
    countsAt: "own_path",
    fingerprint: "the wave's size, subject and body",
    catchUp: "invite_wave",
    kept: "sent",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "content_plan",
    action: "content_plan.draft",
    agent: "vizzy",
    drafts: ["content_plan"],
    target: "brand",
    loop: "canvas.content_plan",
    review: "agent_draft",
    countsAt: "own_path",
    fingerprint: "each piece's role, title and body, and an email's subjects and waits",
    catchUp: "content_plan",
    kept: "approved",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "email_style",
    action: "email_style.suggest",
    agent: "vizzy",
    drafts: ["email_style"],
    target: "brand",
    loop: "canvas.email_style",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "the logo, name, colours, header and theme",
    catchUp: "brand_style",
    kept: "applied",
    adminOnly: true,
    expiryDays: DAYS,
  },
  {
    key: "image_style",
    action: "image_style.suggest",
    agent: "vizzy",
    drafts: ["image_style"],
    target: "brand",
    loop: "canvas.image_style",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "the default style and each channel's",
    catchUp: "brand_style",
    kept: "applied",
    adminOnly: true,
    expiryDays: DAYS,
  },
  {
    key: "journey_style",
    action: "journey_style.suggest",
    agent: "vizzy",
    drafts: ["lifecycle_journey"],
    target: "idea_or_brand",
    loop: "canvas.journey_style",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "the journey's emails, waits and start, and its own email style",
    catchUp: "lifecycle_journey",
    kept: "published",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "brand_map",
    action: "brand_map.suggest",
    agent: "vizzy",
    drafts: ["brand_map"],
    target: "brand",
    loop: "canvas.brand_map",
    review: "brand_map",
    countsAt: "own_path",
    fingerprint: null,
    catchUp: "brand_map_run",
    kept: "accepted",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "brand_note",
    action: "brand_note.suggest",
    agent: "vizzy",
    drafts: ["brand_note"],
    target: "brand",
    loop: "vizzy_chat",
    review: "agent_draft",
    countsAt: "transition",
    fingerprint: "the note's text",
    catchUp: "brand_note",
    kept: "kept",
    adminOnly: true,
    expiryDays: DAYS,
  },
  {
    key: "brand_map_research",
    action: "brand_map.research",
    agent: "research",
    drafts: ["brand_map"],
    target: "brand",
    loop: "brand_map_research",
    review: "brand_map",
    countsAt: "own_path",
    fingerprint: null,
    catchUp: "brand_map_run",
    kept: "accepted",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "product_map",
    action: "product_map.learn",
    agent: "research",
    drafts: ["repo_map"],
    target: "brand",
    loop: "product_map",
    review: "repo_results",
    countsAt: "transition",
    fingerprint: null,
    catchUp: "repo_run",
    kept: "accepted",
    adminOnly: false,
    expiryDays: DAYS,
  },
  {
    key: "autopilot",
    action: "autopilot.draft",
    agent: "autopilot",
    drafts: ["content_plan"],
    target: "brand",
    loop: "autopilot",
    review: "agent_draft",
    countsAt: "own_path",
    fingerprint: "each piece's role, title and body, and an email's subjects and waits",
    catchUp: "content_plan",
    kept: "approved",
    adminOnly: false,
    expiryDays: DAYS,
  },
] as const satisfies readonly SourceLine[];

export type RecordAction = (typeof SOURCES)[number]["action"];
export type RecordKey = (typeof SOURCES)[number]["key"];

/** The line for an action, or null for one this record doesn't keep. */
export function lineFor(action: string): SourceLine | null {
  return (SOURCES as readonly SourceLine[]).find((s) => s.action === action) ?? null;
}

/** The line for get_drafts' kind, or null. */
export function lineByKey(key: string): SourceLine | null {
  return (SOURCES as readonly SourceLine[]).find((s) => s.key === key) ?? null;
}

export const RECORD_ACTIONS: readonly RecordAction[] = SOURCES.map((s) => s.action);

/**
 * Every canvas Vizzy fills: the action its saves are recorded as, or why none is. A new canvas
 * fails typecheck until it has its line here.
 */
export const CANVAS_LINES: Readonly<Record<CanvasKindName, { action: RecordAction } | { none: string }>> = {
  journey: { action: "launch_journey.draft" },
  lifecycle: { action: "lifecycle_journey.draft" },
  invite_wave: { action: "invite_wave.draft" },
  content_plan: { action: "content_plan.draft" },
  email_style: { action: "email_style.suggest" },
  journey_style: { action: "journey_style.suggest" },
  brand_map: { action: "brand_map.suggest" },
  image_style: { action: "image_style.suggest" },
  person_plan: { none: "a plan for one named person stays out of the record (decision 2): it would put Vizzy's drafts on that person's timeline" },
  person_fields: { none: "recorded already, as person_fields.suggest (piece B)" },
  new_person: { none: "recorded already, as new_person.draft (piece B)" },
  raise_deck: {
    none: "not recorded yet: a deck has no approve step and stays a draft, and what a person does next (a later save, Put this version back) shows only in the deck's own changes list, which get_raise_doc reads, and a deleted deck keeps none",
  },
};

/** Superseded, stale and expired are the system's: never a person's no. */
export const SYSTEM_REASONS = ["superseded", "stale", "expired"] as const;

/** Who closes a record when nobody decided. */
export const RECORD_SYSTEM = { type: "system", id: "agent_record" } as const;
