import type { MeaningKey } from "@/lib/metrics/meanings";
import type { LoopKind } from "@/lib/loops/registry";
import type { SearchKind } from "@/lib/search/types";
import type { EventKind } from "./events";

/**
 * The shapes of the ontology registry (src/lib/ontology/registry.ts): every kind of thing YouGrow
 * knows about, where it is kept, whose data it is, and how it is erased, exported, found and
 * counted. Pure types and constants, so tests, scripts and the app can all read them.
 */

/**
 * Where a type sits. The first five are the spine, in order: an idea, its signals, the product
 * (optional), customers and support. The rest are rails beside the spine: the brand's own
 * writing and assets (content), the company itself (company), who acts for the brand
 * (partner_agent), and what runs everything (platform: the brand record, members, organisations,
 * rate limits, audit, queues and copies).
 */
export const PLACES = ["idea", "signals", "product", "customers", "support", "content", "company", "partner_agent", "platform"] as const;
export type Place = (typeof PLACES)[number];

/** The five steps of the spine, in order. */
export const SPINE_STEPS = ["idea", "signals", "product", "customers", "support"] as const satisfies readonly Place[];

/**
 * Where a store lives:
 * - control: the control plane, Firestore's (default) database, one for every region;
 * - regional: the brand's regional Firestore database;
 * - search: the brand's regional search database (brands/{tenantId}/...);
 * - gcs: a Cloud Storage bucket;
 * - bigquery: a BigQuery dataset;
 * - worm: the write once audit bucket;
 * - memory_bank: Vertex AI Memory Bank;
 * - agent_sessions: Agent Engine sessions (members' chats with Vizzy);
 * - external: a provider outside Google Cloud (Mailchimp, Mandrill).
 */
export const STORE_DBS = ["control", "regional", "search", "gcs", "bigquery", "worm", "memory_bank", "agent_sessions", "external"] as const;
export type StoreDb = (typeof STORE_DBS)[number];

/** The Firestore databases the coverage test scans for. */
export const FIRESTORE_DBS = ["control", "regional", "search"] as const satisfies readonly StoreDb[];

export interface StoreRef {
  /** The collection name, or for other stores a short name for what is kept (a table, a file prefix). */
  collection: string;
  db: StoreDb;
  /** The repo file that reads and writes it. */
  definedIn: string;
  /** Where it sits when it is not a top level collection, e.g. workspaces/{workspaceId}/idea_items. */
  path?: string;
  note?: string;
  /** Why the store does not keep to the brand's region, when it does not. */
  residencyGap?: string;
}

/** Whose data a type holds: the brand's people, the brand's own team, or nobody's. */
export const PERSONALS = ["people", "team", "none"] as const;
export type Personal = (typeof PERSONALS)[number];

/**
 * What starts an erase or export path:
 * - person: a person's erase or export (the contact erase job, the whole person export);
 * - product_user: one product user's erase or export;
 * - member: a team member's own action on their data;
 * - launch: deleting a launch;
 * - retention: a time to live or a rolling limit;
 * - brand: someone removing the record itself;
 * - field: an owner erasing an archived field's values (Settings › History, ADR-0021).
 */
export const PATH_TRIGGERS = ["person", "product_user", "member", "launch", "retention", "brand", "field"] as const;
export type PathTrigger = (typeof PATH_TRIGGERS)[number];

export interface PathRef {
  /** The exported function or constant that does it. */
  fn: string;
  /** The repo file that exports it. */
  file: string;
  trigger: PathTrigger;
  /** When it applies, if not always. */
  when?: string;
}

/** Erase or export: the paths that do it (with any gaps), why there is none, or a gap with its reason. */
export type PathDecision = { paths: readonly PathRef[]; gaps?: readonly string[] } | { none: string } | { gap: string };

/** How a type is found: the search kinds it feeds, or why it has none. */
export type SearchDecision = { kinds: readonly SearchKind[] } | { none: string };

/** How its numbers reach an agent: the meanings and the tool that returns them, why there are none, or a gap. */
export type NumberDecision = { meanings: readonly MeaningKey[]; tool: string } | { none: string } | { gap: string };

export interface TypeLink {
  /** Another type's id. */
  to: string;
  /** The field or store that makes the link. */
  via: string;
  /** True when one of this type can point at many of the other. */
  many: boolean;
}

/** A field on a row that says which person it is about, and whether it is written with the row. */
export interface PersonField {
  field: string;
  /** False when the field is filled later (a sync or a backfill), or not yet at all. */
  stampedAtWrite: boolean;
}

/** The pieces of the build plan a planned type waits for. */
export const PLANNED_IN = [
  "0e",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "O part 1",
  "connectors 1",
  "connectors 2",
  "company rail",
  "partner rail",
  "support after the DPA line",
] as const;
export type PlannedIn = (typeof PLANNED_IN)[number];

export interface OntologyType {
  /** Stable and unique: snake case. Other code names a type by this id. */
  id: string;
  name: string;
  /** What it is, in plain words. */
  description: string;
  place: Place;
  status: "built" | "planned";
  /** Planned types only: the piece that builds it. */
  plannedIn?: PlannedIn;
  /**
   * Control plane, the brand's region, or (an organisation's own record, Connectors 3) the region of
   * the brand it was connected from, serving the organisation's brands in any region. "undecided"
   * only on planned types.
   */
  home: "control" | "brand" | "organisation" | "undecided";
  /** "undecided" only on planned types. */
  personal: Personal | "undecided";
  /** Built types only. */
  stores: readonly StoreRef[];
  links: readonly TypeLink[];
  /** The kinds of event it produces (src/lib/ontology/events.ts). */
  events: readonly EventKind[];
  states?: readonly string[];
  personFields?: readonly PersonField[];
  erase: PathDecision;
  export: PathDecision;
  search: SearchDecision;
  numbers: NumberDecision;
  /**
   * The places YouGrow makes a choice for a brand (src/lib/loops/registry.ts) whose choices this
   * type's stores hold or were shaped by. Empty when the stores hold no choice YouGrow makes: what
   * people typed or did, outside numbers, or plumbing. Planned types hold nothing yet.
   */
  madeBy: readonly LoopKind[];
}
