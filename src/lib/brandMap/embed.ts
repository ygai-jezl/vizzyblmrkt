import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { cutOff, situationSearchSource, subjectSearchSource, type CutOff } from "@/lib/search/family";
import { embedForFamily, indexFamily, nearestFamily, removeFamily, type FamilyDeps } from "@/lib/search/familyIndex";
import { isOldVectorsRetired, isSearchFamilyIndexEnabled, isSearchSubjectReadsEnabled } from "@/lib/search/flags";
import { isSearchStatus, type NearestHit, type SearchSource, type SearchStatus } from "@/lib/search/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { nearestBrandMapRecords, writeBrandMapVector, type BrandMapNeighbour } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import { meaningWords } from "@/lib/content/blog/coverage";
import { parseSubject, subjectIndex, subjectQuestions } from "./records";

/**
 * Meaning for the map at any size (BRAND_MAP_SCALE_ENABLED): each subject and buying
 * situation is embedded as it is written (a subject by its name and first questions), so the
 * part of the map close to an article, a situation or a PDF's question can be found among
 * thousands. Best effort: a subject without an embedding is still on the map, and when
 * embeddings are down the nearest are found by shared words instead.
 *
 * Two stores (ADR-0023). Every write goes to brand_map_vectors (text-embedding-005) and, with
 * SEARCH_FAMILY_INDEX_ENABLED, to brand search (gemini-embedding-001), awaited, so a duplicate
 * check right after sees a new proposal. With SEARCH_SUBJECT_READS_ENABLED the readers use brand
 * search only; off, brand_map_vectors, which is still written, so turning it off is a rollback.
 * Each reader keeps its task type on both: nearestSubjects and nearestSituations ask as a query;
 * nearestSubjectsMany and the "looks like" check compare documents with documents.
 */

export interface EmbedDeps extends FamilyDeps {
  db?: FirestoreLike;
  nowMs?: number;
  /** Test seams. */
  embed?: typeof embedDocuments;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

/**
 * A proposal at least this close to a subject on the map is shown as "looks like" it. `new` is
 * provisional until scripts/measure-question-dupes.ts --model new is run (ADR-0023): it is used
 * only once SEARCH_SUBJECT_READS_ENABLED is on.
 */
export const LOOKS_LIKE: CutOff = { old: 0.9, new: 0.9 };
const FIRST_QUESTIONS = 10;

/** A family hit as the brand map's readers return it. */
const neighbour = (h: NearestHit): BrandMapNeighbour => ({ ref: h.ref, status: h.status, sim: h.score });
const searchStatuses = (statuses: string[]): SearchStatus[] => statuses.filter(isSearchStatus);

export const subjectText = (name: string, questions: string[]) => [name, ...questions.slice(0, FIRST_QUESTIONS)].join("\n");
export const situationText = (s: Pick<BrandMapSituation, "text" | "who" | "wText" | "want">) => [s.text, s.who, s.wText, s.want].filter(Boolean).join("\n");

/**
 * Records written through to brand search (SEARCH_FAMILY_INDEX_ENABLED), and those no longer on the
 * map taken out: each written one's first vector, by id. Off: nothing, and no vectors.
 */
async function indexOrRemove(ctx: TenantContext, kind: "subject" | "situation", ids: string[], sources: Array<SearchSource | null>, deps: EmbedDeps): Promise<Map<string, number[] | null>> {
  if (!isSearchFamilyIndexEnabled()) return new Map();
  const present = sources.filter((src): src is SearchSource => src !== null);
  const results = await indexFamily(ctx, present, deps);
  const gone = ids.filter((_, i) => !sources[i]);
  if (gone.length) await removeFamily(ctx, kind, gone, deps);
  return new Map(present.map((src, i) => [src.ref, results[i]?.vector ?? null]));
}

/**
 * Embed these subjects (by name and first questions), and mark a proposal that looks like one on
 * the map. Both stores get them (ADR-0023); the check reads the one the readers use. Returns how
 * many got a vector.
 */
export async function embedSubjects(ctx: TenantContext, ids: string[], deps: EmbedDeps = {}): Promise<number> {
  const unique = [...new Set(ids)];
  if (!unique.length) return 0;
  const store = brandMapRecords(ctx, deps.db);
  const raws = await store.getMany("sub", unique);
  const subjects = raws.flatMap((r) => {
    const s = parseSubject(r);
    return s ? [{ s, raw: r }] : [];
  });
  const questions = await Promise.all(subjects.map(async ({ s }) => (await subjectQuestions(ctx, s.id, deps)).filter((q) => q.status !== "dismissed")));
  const onIndex = isSearchSubjectReadsEnabled();

  // Brand search: the text the sweep makes too. A subject no longer on the map leaves it.
  const fresh = await indexOrRemove(ctx, "subject", subjects.map(({ s }) => s.id), subjects.map(({ raw }, i) => subjectSearchSource(raw, questions[i]!)), deps);

  // brand_map_vectors, until it is retired: then nothing is embedded for it.
  const old = isOldVectorsRetired()
    ? subjects.map(() => null)
    : await (deps.embed ?? embedDocuments)(
        subjects.map(({ s }, i) => ({ content: subjectText(s.name, questions[i]!.map((q) => q.text)), title: "Subject" })),
        ctx.region,
      );
  let done = 0;
  for (const [i, { s }] of subjects.entries()) {
    const vector = old[i];
    if (vector) await writeBrandMapVector(ctx, { kind: "subject", ref: s.id, status: s.status }, vector, deps.db);
    const indexVector = fresh.get(s.id) ?? null;
    if (vector || indexVector) done += 1;
    if (s.status !== "proposed") continue;
    // A proposal close to a subject already on the map says so; a person decides.
    let like: string | null | undefined;
    if (onIndex) {
      if (!indexVector) continue;
      const near = await nearestFamily(ctx, ["subject"], indexVector, { statuses: ["decided"], limit: 2, minScore: cutOff(LOOKS_LIKE, true) }, deps).catch(() => null);
      // Couldn't look: the mark stays as it is.
      if (!near) continue;
      like = near.find((n) => n.ref !== s.id)?.ref ?? null;
    } else {
      if (!vector) continue;
      const [near] = await nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: 2, statuses: ["decided"], minSim: cutOff(LOOKS_LIKE, false) }, deps.vectors).catch(() => []);
      like = near && near.ref !== s.id ? near.ref : null;
    }
    if (like !== s.looksLike) await store.claim("sub", s.id, () => ({ looksLike: like }));
  }
  return done;
}

/** Embed these buying situations, in both stores (ADR-0023). A dismissed one leaves brand search. */
export async function embedSituations(ctx: TenantContext, situations: BrandMapSituation[], deps: EmbedDeps = {}): Promise<number> {
  if (!situations.length) return 0;
  const fresh = await indexOrRemove(ctx, "situation", situations.map((s) => s.id), situations.map((s) => situationSearchSource({ ...s, ref: s.id })), deps);

  const vectors = isOldVectorsRetired()
    ? situations.map(() => null)
    : await (deps.embed ?? embedDocuments)(situations.map((s) => ({ content: situationText(s), title: "Buying situation" })), ctx.region);
  let done = 0;
  for (const [i, s] of situations.entries()) {
    const vector = vectors[i];
    if (vector) await writeBrandMapVector(ctx, { kind: "situation", ref: s.id, status: s.status }, vector, deps.db);
    if (vector || fresh.get(s.id)) done += 1;
  }
  return done;
}

/**
 * Names by the share of their meaningful words the text has, most first. With `fill`, the
 * rest of the names follow them up to the limit: placing a question needs to see the map,
 * and on a small one few names share a word with it.
 */
function byWords(names: Array<{ id: string; status: string; name: string }>, text: string, limit: number, fill: boolean): BrandMapNeighbour[] {
  const words = new Set(meaningWords(text));
  const scored = names.map((n) => {
    const own = meaningWords(n.name);
    return { ref: n.id, status: n.status, sim: own.length ? own.filter((w) => words.has(w)).length / own.length : 0 };
  });
  const near = scored.filter((n) => n.sim > 0).sort((a, b) => b.sim - a.sim || a.ref.localeCompare(b.ref)).slice(0, limit);
  if (!fill || near.length >= limit) return near;
  const taken = new Set(near.map((n) => n.ref));
  return [...near, ...scored.filter((n) => !taken.has(n.ref)).sort((a, b) => a.ref.localeCompare(b.ref))].slice(0, limit);
}

/** By shared meaningful words, when meaning can't be had: every name is read once. */
async function nearestByWords(ctx: TenantContext, text: string, limit: number, statuses: string[], fill: boolean, deps: EmbedDeps): Promise<BrandMapNeighbour[]> {
  if (!meaningWords(text).length && !fill) return [];
  const names = await subjectIndex(ctx, deps);
  return byWords(names.filter((n) => statuses.includes(n.status)), text, limit, fill);
}

/**
 * The subjects nearest a piece of text, most similar first: by meaning, else by shared words
 * (with `fill`, the rest of the map after them, up to the limit).
 */
export async function nearestSubjects(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; statuses?: string[]; fill?: boolean },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[]> {
  const statuses = opts.statuses ?? ["decided"];
  if (isSearchSubjectReadsEnabled()) {
    // Brand search only; an error, or nothing near, falls back to shared words as before.
    const [vector] = await embedForFamily(ctx, [text], { query: true }, deps);
    if (vector) {
      const found = await nearestFamily(ctx, ["subject"], vector, { statuses: searchStatuses(statuses), limit: opts.limit }, deps).catch(() => null);
      if (found?.length) return found.map(neighbour);
    }
    return nearestByWords(ctx, text, opts.limit, statuses, Boolean(opts.fill), deps);
  }
  const vector = await (deps.query ?? embedQuery)(text, ctx.region).catch(() => null);
  if (vector) {
    const found = await nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: opts.limit, statuses }, deps.vectors).catch(() => null);
    if (found?.length) return found;
  }
  return nearestByWords(ctx, text, opts.limit, statuses, Boolean(opts.fill), deps);
}

/**
 * The subjects nearest each of many short texts (a PDF's questions, a batch at a time): one
 * embedding call for them all, then one lookup each; when meaning can't be had, by shared
 * words, every name read once.
 */
export async function nearestSubjectsMany(
  ctx: TenantContext,
  texts: string[],
  opts: { limit: number; statuses?: string[]; fill?: boolean },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[][]> {
  if (!texts.length) return [];
  const statuses = opts.statuses ?? ["decided"];
  if (isSearchSubjectReadsEnabled()) {
    // Documents compared with documents, as the indexer embeds subjects.
    const vectors = await embedForFamily(ctx, texts, { title: () => "Question" }, deps);
    if (vectors.some(Boolean)) {
      return Promise.all(
        vectors.map((vector) =>
          vector
            ? nearestFamily(ctx, ["subject"], vector, { statuses: searchStatuses(statuses), limit: opts.limit }, deps).then((hits) => hits.map(neighbour)).catch(() => [])
            : Promise.resolve([]),
        ),
      );
    }
    const names = (await subjectIndex(ctx, deps).catch(() => [])).filter((n) => statuses.includes(n.status));
    return texts.map((text) => byWords(names, text, opts.limit, Boolean(opts.fill)));
  }
  const vectors = await (deps.embed ?? embedDocuments)(texts.map((content) => ({ content, title: "Question" })), ctx.region).catch(() => texts.map(() => null));
  if (vectors.some(Boolean)) {
    return Promise.all(
      vectors.map((vector) => (vector ? nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: opts.limit, statuses }, deps.vectors).catch(() => []) : Promise.resolve([]))),
    );
  }
  const names = (await subjectIndex(ctx, deps).catch(() => [])).filter((n) => statuses.includes(n.status));
  return texts.map((text) => byWords(names, text, opts.limit, Boolean(opts.fill)));
}

/** The buying situations nearest a piece of text (by meaning only: a brand has far fewer). */
export async function nearestSituations(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; statuses?: string[] },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[]> {
  const statuses = opts.statuses ?? ["decided"];
  if (isSearchSubjectReadsEnabled()) {
    // Brand search only; an error finds none, as before.
    const [vector] = await embedForFamily(ctx, [text], { query: true }, deps);
    if (!vector) return [];
    return nearestFamily(ctx, ["situation"], vector, { statuses: searchStatuses(statuses), limit: opts.limit }, deps).then((hits) => hits.map(neighbour)).catch(() => []);
  }
  const vector = await (deps.query ?? embedQuery)(text, ctx.region).catch(() => null);
  if (!vector) return [];
  return nearestBrandMapRecords(ctx, { kind: "situation", vector, limit: opts.limit, statuses }, deps.vectors).catch(() => []);
}
