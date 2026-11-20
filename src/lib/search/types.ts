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
  "idea",
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
 * Kind names that may be stored or asked for, read as one of today's kinds. `idea_board` is the
 * name piece 0b will write for an Idea Board item, read as today's `idea`: the app reads the new
 * name before anything writes it, so reverting 0b leaves nothing in the index that can't be read.
 */
export const SEARCH_KIND_ALIASES: Readonly<Record<string, SearchKind>> = { idea_board: "idea" };

/** How many alias names there are, for limits on lists of kinds. */
export const SEARCH_KIND_ALIAS_COUNT = Object.keys(SEARCH_KIND_ALIASES).length;

/** A stored or requested kind as one of today's kinds: a current kind, an alias mapped to its kind, or null. */
export function readSearchKind(value: unknown): SearchKind | null {
  if (isSearchKind(value)) return value;
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(SEARCH_KIND_ALIASES, value)) return SEARCH_KIND_ALIASES[value]!;
  return null;
}

/** The kind values to look for in the index: the kinds, plus every alias stored for one of them. */
export function storedKindsFor(kinds: readonly SearchKind[]): string[] {
  const out = new Set<string>(kinds);
  for (const [alias, kind] of Object.entries(SEARCH_KIND_ALIASES)) if (kinds.includes(kind)) out.add(alias);
  return [...out];
}

/** Each kind once, in first seen order. */
export function dedupeKinds<T extends string>(kinds: readonly T[]): T[] {
  return [...new Set(kinds)];
}

/** A kind as a request names it: a current kind or an alias, read as the current kind. */
export const SearchKindInput = z.string().transform(readSearchKind).pipe(z.enum(SEARCH_KINDS));

/** One record to index, as a feeder reads it through the tenant layer. */
export interface SearchSource {
  kind: SearchKind;
  /** The record's id within its kind. */
  ref: string;
  title: string;
  body: string;
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
  load(): Promise<SearchSource | null>;
}

/** One stored chunk (brands/{tenantId}/search_docs/{id}). */
export interface SearchChunkDoc {
  tenantId: string;
  kind: SearchKind;
  ref: string;
  sourceKey: string;
  chunk: number;
  title: string;
  text: string;
  url: string;
  lang: string;
  updatedAt: string;
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
}

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
}

/** One brand's index. Every method is already bound to one brand (see searchStoreFor). */
export interface SearchStore {
  getManifest(sourceKey: string): Promise<SearchManifest | null>;
  listManifests(): Promise<SearchManifest[]>;
  /** Replace a record's chunks (and drop chunks past the new count), then its manifest. */
  putSource(manifest: SearchManifest, chunks: SearchChunkDoc[], previousChunks: number): Promise<void>;
  /** Rewrite only a manifest (its version moved but the text didn't). */
  putManifest(manifest: SearchManifest): Promise<void>;
  removeSource(sourceKey: string): Promise<void>;
  /** Text search. `query` is already in the words query syntax (see wordsQueries). */
  words(query: string, opts: { limit: number; kinds?: SearchKind[]; lang?: string }): Promise<RankedChunk[]>;
  meaning(vector: number[], opts: { limit: number; kinds?: SearchKind[] }): Promise<RankedChunk[]>;
  /** Delete everything this brand has in the index; returns how many chunks went. */
  clear(): Promise<number>;
}

export function sourceKeyOf(kind: SearchKind, ref: string): string {
  return `${kind}:${ref}`;
}
