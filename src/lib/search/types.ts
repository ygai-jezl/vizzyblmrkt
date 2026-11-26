import { z } from "zod";

/**
 * Brand search: the shapes shared by the indexer, the store (src/lib/tenant/searchIndex.ts, the
 * only code that touches the search databases), the query and the screens.
 *
 * People's words (sign-up answers, AI conversations, comments, contacts) are NOT a kind: they
 * wait for the data processing agreement to cover a new store of personal data.
 */

/** What a brand wrote, by kind. The order is the order the Search panel lists them in. */
export const SEARCH_KINDS = [
  "article",
  "newsletter",
  "ebook",
  "post",
  "idea_board",
  "template",
  "journey_email",
  "broadcast",
  "brand_kit",
  "subject",
  "situation",
  "question",
  "note",
  "research",
  "knowledge",
  "competitor",
  "repo_map",
  "image",
  "learned",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === "string" && (SEARCH_KINDS as readonly string[]).includes(value);
}

/**
 * Older kind names that may be stored or asked for, read as one of today's kinds. An Idea Board
 * item was `idea` until it became `idea_board`, which frees "idea" for a business idea. It is
 * still written as `idea` while SEARCH_KIND_IDEA_BOARD_ENABLED is off (storedKindOf in
 * ./indexer.ts), and reads take both names either way. Piece 0a shipped the reverse alias
 * ({idea_board: "idea"}), so reverting this change still reads both names.
 */
export const SEARCH_KIND_ALIASES = { idea: "idea_board" } as const satisfies Readonly<Record<string, SearchKind>>;

/** An older kind name (SEARCH_KIND_ALIASES). */
export type SearchKindAlias = keyof typeof SEARCH_KIND_ALIASES;

/** A kind name as the index stores it: one of today's kinds, or an older name read as one. */
export type StoredSearchKind = SearchKind | SearchKindAlias;

/** How many alias names there are, for limits on lists of kinds. */
export const SEARCH_KIND_ALIAS_COUNT = Object.keys(SEARCH_KIND_ALIASES).length;

/** A stored or requested kind as one of today's kinds: a current kind, an alias mapped to its kind, or null. */
export function readSearchKind(value: unknown): SearchKind | null {
  if (isSearchKind(value)) return value;
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(SEARCH_KIND_ALIASES, value)) return SEARCH_KIND_ALIASES[value as SearchKindAlias];
  return null;
}

/** The kind values to look for in the index: the kinds, plus every alias stored for one of them. */
export function storedKindsFor(kinds: readonly SearchKind[]): StoredSearchKind[] {
  const out = new Set<StoredSearchKind>(kinds);
  for (const [alias, kind] of Object.entries(SEARCH_KIND_ALIASES) as Array<[SearchKindAlias, SearchKind]>) if (kinds.includes(kind)) out.add(alias);
  return [...out];
}

/** Each kind once, in first seen order. */
export function dedupeKinds<T extends string>(kinds: readonly T[]): T[] {
  return [...new Set(kinds)];
}

/** A kind as a request names it: a current kind or an alias, read as the current kind. */
export const SearchKindInput = z.string().transform(readSearchKind).pipe(z.enum(SEARCH_KINDS));

/**
 * Where a record stands, kept on its chunks (SEARCH_FAMILY_INDEX_ENABLED, ADR-0023): the brand map's
 * subjects and situations are `decided` or `proposed`, notes `kept`, open questions `asked` or
 * `answered`, competitor articles `kept`. Every other record has none.
 */
export const SEARCH_STATUSES = ["decided", "proposed", "kept", "asked", "answered"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

export function isSearchStatus(value: unknown): value is SearchStatus {
  return typeof value === "string" && (SEARCH_STATUSES as readonly string[]).includes(value);
}

/**
 * What people's search (Ctrl K, the Search card and Vizzy's search_brand) shows: a chunk with no
 * status, or one of these. Proposals and answered questions are only for the readers that match
 * by meaning (SearchStore.nearest).
 */
export const PEOPLE_STATUSES = ["decided", "kept", "asked"] as const satisfies readonly SearchStatus[];

/** Whether people's search may show a chunk or count a record with this status. */
export function shownToPeople(status: unknown): boolean {
  return status === undefined || status === null || (PEOPLE_STATUSES as readonly unknown[]).includes(status);
}

/** One record to index, as a feeder reads it through the tenant layer. */
export interface SearchSource {
  kind: SearchKind;
  /** The record's id within its kind. */
  ref: string;
  title: string;
  body: string;
  /** Where the record stands (SEARCH_STATUSES); none for most kinds. Not part of the text's hash. */
  status?: SearchStatus;
  /** How `body` is written. Default "plain". */
  format?: "plain" | "markdown" | "html";
  /** The admin page that opens the record, e.g. "/admin/content/abc". */
  url?: string;
  /** BCP-47 language of the text. Default "en". */
  lang?: string;
  /**
   * Already in pieces (a knowledge source's chunks): each part becomes one chunk with its own
   * title and link, and `body` is ignored.
   */
  parts?: Array<{ title?: string; text: string; url?: string }>;
}

/**
 * What the scheduled check sees of a record before reading it in full: a version that changes
 * when the record does. Unchanged version, nothing read or embedded.
 */
export interface SearchStub {
  kind: SearchKind;
  ref: string;
  version: string;
  /** The record's status, when it has one (it is part of `version`). */
  status?: SearchStatus;
  load(): Promise<SearchSource | null>;
}

/** One stored chunk (brands/{tenantId}/search_docs/{id}). */
export interface SearchChunkDoc {
  tenantId: string;
  /** The name it is stored under (storedKindOf); reads give today's kind. */
  kind: StoredSearchKind;
  ref: string;
  sourceKey: string;
  chunk: number;
  title: string;
  text: string;
  url: string;
  lang: string;
  updatedAt: string;
  /** Where the record stands, when it has a status (people's search shows only PEOPLE_STATUSES or none). */
  status?: SearchStatus;
  /** Unit length, SEARCH_EMBEDDING_DIM numbers. Missing when embedding failed (words still find it). */
  embedding?: number[];
  embeddingModel?: string;
}

/** What is indexed for one record (brands/{tenantId}/search_sources/{id}): the scheduled check reads only these. */
export interface SearchManifest {
  sourceKey: string;
  kind: SearchKind;
  ref: string;
  /** Hash of the model, title, link, language and chunks: unchanged means nothing to do. */
  hash: string;
  chunks: number;
  /** False when some chunk has no embedding yet; the scheduled check tries again. */
  embedded: boolean;
  indexedAt: string;
  /** The SearchStub version it was indexed at, when the scheduled check indexed it. */
  version?: string;
  /** The record's status, as its chunks hold it. */
  status?: SearchStatus;
}

/** A manifest as written: its kind is the name it is stored under (storedKindOf), which may be an older one. */
export type StoredSearchManifest = Omit<SearchManifest, "kind"> & { kind: StoredSearchKind };

/** A chunk a search found, in rank order. */
export interface RankedChunk {
  id: string;
  sourceKey: string;
  kind: SearchKind;
  ref: string;
  chunk: number;
  title: string;
  text: string;
  url: string;
  status?: SearchStatus;
}

/** A record a reader found by meaning (SearchStore.nearest): once, by its best chunk. */
export interface NearestHit {
  sourceKey: string;
  kind: SearchKind;
  ref: string;
  status: SearchStatus;
  /** The dot product of unit vectors (cosine), clamped to 0 to 1. */
  score: number;
}

/** One brand's index. Every method is already bound to one brand (see searchStoreFor). */
export interface SearchStore {
  getManifest(sourceKey: string): Promise<SearchManifest | null>;
  listManifests(): Promise<SearchManifest[]>;
  /** Replace a record's chunks (and drop chunks past the new count), then its manifest. */
  putSource(manifest: StoredSearchManifest, chunks: SearchChunkDoc[], previousChunks: number): Promise<void>;
  /** Rewrite only a manifest (its version moved but the text didn't). */
  putManifest(manifest: StoredSearchManifest): Promise<void>;
  removeSource(sourceKey: string): Promise<void>;
  /**
   * Rewrite a record's status on its chunks and manifest, with no embedding (null: take it off).
   * Its text didn't change, so its vectors stay.
   */
  setStatus(sourceKey: string, status: SearchStatus | null): Promise<void>;
  /** The vector of a record's first chunk, or null (not indexed, or not embedded). */
  vectorOf(sourceKey: string): Promise<number[] | null>;
  /**
   * People's text search: only chunks people may find (shownToPeople), filtered before the
   * search. `query` is already in the words query syntax (see wordsQueries).
   */
  words(query: string, opts: { limit: number; kinds?: SearchKind[]; lang?: string }): Promise<RankedChunk[]>;
  /** People's search by meaning: only chunks people may find, filtered before the nearest are taken. */
  meaning(vector: number[], opts: { limit: number; kinds?: SearchKind[] }): Promise<RankedChunk[]>;
  /**
   * For the readers that match by meaning (ADR-0023): the records of these kinds and statuses
   * nearest a vector, filtered before the nearest are taken, each record once (its best chunk),
   * nearest first. A chunk with no status never matches.
   */
  nearest(kinds: SearchKind[], vector: number[], opts: { statuses: SearchStatus[]; limit: number }): Promise<NearestHit[]>;
  /** Delete everything this brand has in the index; returns how many chunks went. */
  clear(): Promise<number>;
}

/** A record's key in the index, from the kind name it is stored under (see storedSourceKey in ./indexer.ts). */
export function sourceKeyOf(kind: StoredSearchKind, ref: string): string {
  return `${kind}:${ref}`;
}
