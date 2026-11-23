import { embedForSearch } from "@/lib/agents/embeddings";
import { isConnectorsSearchTextEnabled } from "@/lib/connectors/flags";
import { can, type ConnectorActor } from "@/lib/connectors/grants";
import { connectionOfSearchRef } from "@/lib/connectors/keys";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { forTenant } from "@/lib/tenant";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { TenantRole } from "@/lib/types/tenantUser";
import { isSearchEnabled } from "./flags";
import { rerank } from "./rerank";
import { queryTerms, reciprocalRankFusion, wordsQueries } from "./text";
import type { RankedChunk, SearchKind, SearchStore } from "./types";

/**
 * One brand's search: by words (the whole query, then each key term, because Firestore's text
 * search ANDs its terms) and by meaning (the query's embedding), side by side, merged with
 * reciprocal rank fusion, one result per record, then reranked for US brands when that is on.
 *
 * Searches from a connection (Search Console's, ref `gsc:<connectionId>`, ADR-0013) follow the
 * viewer's access: they show only to a viewer who may read that connection, as its grants say
 * (src/lib/connectors/grants.ts), only while it is connected and CONNECTORS_SEARCH_TEXT_ENABLED is
 * on. A caller that names no viewer gets none of them.
 */

export const MAX_QUERY_CHARS = 500;
/** Each side fetches this many chunks before the merge. */
const CANDIDATES = 50;
const SNIPPET_CHARS = 220;

export interface SearchHit {
  sourceKey: string;
  kind: SearchKind;
  ref: string;
  title: string;
  url: string;
  snippet: string;
  /** Which side found it: its words, its meaning, or both. */
  matched: "words" | "meaning" | "both";
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  reranked: boolean;
  /** False when the query couldn't be embedded, so only words were searched. */
  meaning: boolean;
}

export type SearchOutcome = { ok: true; result: SearchResult } | { ok: false; error: "search_disabled" | "not_granted" };

export interface QueryDeps {
  store?: SearchStore;
  embed?: typeof embedForSearch;
  rerank?: typeof rerank;
  granted?: boolean;
  /** Where the connections' grants are read (tests pass a fake). */
  db?: FirestoreLike;
}

/**
 * Who is looking: a person in the app (their role and user id), or Vizzy reading for the person
 * whose role its canvas token carries. A search with no viewer never shows a connection's searches.
 */
export type SearchViewer = { role: TenantRole | undefined; uid: string } | { agent: "vizzy"; forRole: TenantRole | undefined };

/** The viewer as the connections' grants table sees them. */
export function viewerActor(viewer: SearchViewer): ConnectorActor {
  return "agent" in viewer ? { kind: "agent", agent: "vizzy", forRole: viewer.forRole } : { kind: "human", uid: viewer.uid, role: viewer.role };
}

/**
 * Of these connections, the ones whose searches this viewer may find: connected Search Console
 * connections it may read live. None without a viewer, or while CONNECTORS_SEARCH_TEXT_ENABLED is
 * off; a connection that can't be read counts as not readable.
 */
export async function readableConnections(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  viewer: SearchViewer | undefined,
  ids: readonly string[],
  deps: Pick<QueryDeps, "db"> = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!viewer || !ids.length || !isConnectorsSearchTextEnabled()) return out;
  const actor = viewerActor(viewer);
  const repo = forTenant({ source: "system", ...ctx }, deps.db);
  for (const id of new Set(ids)) {
    const c = await repo.dataConnections.getById(id).catch(() => null);
    if (c && c.status === "connected" && c.connectorId === searchConsoleManifest.id && can(actor, "read_live", c.grants)) out.add(id);
  }
  return out;
}

/** A short piece of the chunk around the first term it contains (or its start). */
export function snippetFor(text: string, query: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= SNIPPET_CHARS) return clean;
  const lower = clean.toLowerCase();
  const terms = queryTerms(query).map((t) => t.replace(/"/g, ""));
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || at < SNIPPET_CHARS / 2) return `${clean.slice(0, SNIPPET_CHARS).replace(/\s\S*$/, "")}…`;
  const start = clean.lastIndexOf(" ", at - 60) + 1;
  return `…${clean.slice(start, start + SNIPPET_CHARS).replace(/\s\S*$/, "")}…`;
}

export async function searchBrand(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  query: string,
  opts: { kinds?: SearchKind[]; limit?: number; viewer?: SearchViewer } = {},
  deps: QueryDeps = {},
): Promise<SearchOutcome> {
  if (!isSearchEnabled()) return { ok: false, error: "search_disabled" };
  if (!(deps.granted ?? (await brandCanUse(ctx, "brand_search")))) return { ok: false, error: "not_granted" };
  const q = query.trim().slice(0, MAX_QUERY_CHARS);
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  if (!q) return { ok: true, result: { hits: [], reranked: false, meaning: false } };
  const store = deps.store ?? searchStoreFor(ctx);
  const kinds = opts.kinds?.length ? opts.kinds : undefined;

  const wq = wordsQueries(q);
  const [wordsLists, vector] = await Promise.all([
    Promise.all(wq.map((w) => store.words(w, { limit: CANDIDATES, kinds }).catch(() => [] as RankedChunk[]))),
    (deps.embed ?? embedForSearch)([{ content: q }], ctx.region, "RETRIEVAL_QUERY").then((v) => v[0] ?? null).catch(() => null),
  ]);
  const meaningList = vector ? await store.meaning(vector, { limit: CANDIDATES, kinds }).catch(() => [] as RankedChunk[]) : [];

  const chunks = new Map<string, RankedChunk>();
  for (const c of [...wordsLists.flat(), ...meaningList]) if (!chunks.has(c.id)) chunks.set(c.id, c);
  // The whole query counts twice as much as a single term.
  const words = reciprocalRankFusion(wordsLists.map((l) => l.map((c) => c.id)), wordsLists.map((_, i) => (i === 0 ? 2 : 1))).map((x) => x.id);
  const fused = reciprocalRankFusion([words, meaningList.map((c) => c.id)]);
  const inWords = new Set(words);
  const inMeaning = new Set(meaningList.map((c) => c.id));
  // A connection's searches stay only for a viewer who may read it: its grants are read once,
  // and only when one is among what was found.
  const fromConnections = [...chunks.values()].map((c) => connectionOfSearchRef(c.ref)).filter((id): id is string => id !== null);
  const readable = fromConnections.length ? await readableConnections(ctx, opts.viewer, fromConnections, deps) : new Set<string>();

  // One result per record: its best chunk.
  const bestText = new Map<string, string>();
  let hits: SearchHit[] = [];
  for (const { id, score } of fused) {
    const c = chunks.get(id);
    if (!c || bestText.has(c.sourceKey)) continue;
    const connection = connectionOfSearchRef(c.ref);
    if (connection !== null && !readable.has(connection)) continue;
    bestText.set(c.sourceKey, c.text);
    hits.push({
      sourceKey: c.sourceKey,
      kind: c.kind,
      ref: c.ref,
      title: c.title || c.text.slice(0, 80),
      url: c.url,
      snippet: snippetFor(c.text, q),
      matched: inWords.has(id) && inMeaning.has(id) ? "both" : inWords.has(id) ? "words" : "meaning",
      score,
    });
    if (hits.length >= Math.max(limit, 20)) break;
  }

  const order = await (deps.rerank ?? rerank)(
    q,
    hits.map((h) => ({ id: h.sourceKey, title: h.title, content: bestText.get(h.sourceKey) ?? h.snippet })),
    ctx.region,
  );
  let reranked = false;
  if (order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    hits = [...hits].sort((a, b) => (pos.get(a.sourceKey) ?? 1e9) - (pos.get(b.sourceKey) ?? 1e9));
    reranked = true;
  }
  return { ok: true, result: { hits: hits.slice(0, limit), reranked, meaning: Boolean(vector) } };
}
