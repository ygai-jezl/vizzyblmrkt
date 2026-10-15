import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
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
 */

export interface EmbedDeps {
  db?: FirestoreLike;
  nowMs?: number;
  /** Test seams. */
  embed?: typeof embedDocuments;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

/** A proposal at least this close to a subject on the map is shown as "looks like" it. */
export const LOOKS_LIKE = 0.9;
const FIRST_QUESTIONS = 10;

export const subjectText = (name: string, questions: string[]) => [name, ...questions.slice(0, FIRST_QUESTIONS)].join("\n");
export const situationText = (s: Pick<BrandMapSituation, "text" | "who" | "wText" | "want">) => [s.text, s.who, s.wText, s.want].filter(Boolean).join("\n");

/** Embed these subjects (by name and first questions), and mark a proposal that looks like one on the map. */
export async function embedSubjects(ctx: TenantContext, ids: string[], deps: EmbedDeps = {}): Promise<number> {
  const unique = [...new Set(ids)];
  if (!unique.length) return 0;
  const store = brandMapRecords(ctx, deps.db);
  const subjects = (await store.getMany("sub", unique)).flatMap((r) => parseSubject(r) ?? []);
  const texts = await Promise.all(
    subjects.map(async (s) => subjectText(s.name, (await subjectQuestions(ctx, s.id, deps)).filter((q) => q.status !== "dismissed").map((q) => q.text))),
  );
  const vectors = await (deps.embed ?? embedDocuments)(texts.map((content) => ({ content, title: "Subject" })), ctx.region);
  let done = 0;
  for (const [i, s] of subjects.entries()) {
    const vector = vectors[i];
    if (!vector) continue;
    await writeBrandMapVector(ctx, { kind: "subject", ref: s.id, status: s.status }, vector, deps.db);
    done += 1;
    if (s.status !== "proposed") continue;
    // A proposal close to a subject already on the map says so; a person decides.
    const [near] = await nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: 2, statuses: ["decided"], minSim: LOOKS_LIKE }, deps.vectors).catch(() => []);
    const like = near && near.ref !== s.id ? near.ref : null;
    if (like !== s.looksLike) await store.claim("sub", s.id, () => ({ looksLike: like }));
  }
  return done;
}

/** Embed these buying situations. */
export async function embedSituations(ctx: TenantContext, situations: BrandMapSituation[], deps: EmbedDeps = {}): Promise<number> {
  if (!situations.length) return 0;
  const vectors = await (deps.embed ?? embedDocuments)(situations.map((s) => ({ content: situationText(s), title: "Buying situation" })), ctx.region);
  let done = 0;
  for (const [i, s] of situations.entries()) {
    const vector = vectors[i];
    if (!vector) continue;
    await writeBrandMapVector(ctx, { kind: "situation", ref: s.id, status: s.status }, vector, deps.db);
    done += 1;
  }
  return done;
}

/** By shared meaningful words, when meaning can't be had: every name is read once. */
async function nearestByWords(ctx: TenantContext, text: string, limit: number, statuses: string[], deps: EmbedDeps): Promise<BrandMapNeighbour[]> {
  const words = new Set(meaningWords(text));
  if (!words.size) return [];
  const names = await subjectIndex(ctx, deps);
  return names
    .filter((n) => statuses.includes(n.status))
    .map((n) => {
      const own = meaningWords(n.name);
      const shared = own.filter((w) => words.has(w)).length;
      return { ref: n.id, status: n.status, sim: own.length ? shared / own.length : 0 };
    })
    .filter((n) => n.sim > 0)
    .sort((a, b) => b.sim - a.sim || a.ref.localeCompare(b.ref))
    .slice(0, limit);
}

/** The subjects nearest a piece of text, most similar first: by meaning, else by shared words. */
export async function nearestSubjects(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; statuses?: string[] },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[]> {
  const statuses = opts.statuses ?? ["decided"];
  const vector = await (deps.query ?? embedQuery)(text, ctx.region).catch(() => null);
  if (vector) {
    const found = await nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: opts.limit, statuses }, deps.vectors).catch(() => null);
    if (found?.length) return found;
  }
  return nearestByWords(ctx, text, opts.limit, statuses, deps);
}

/**
 * The subjects nearest each of many short texts (a PDF's questions, a batch at a time): one
 * embedding call for them all, then one lookup each; when meaning can't be had, by shared
 * words, every name read once.
 */
export async function nearestSubjectsMany(
  ctx: TenantContext,
  texts: string[],
  opts: { limit: number; statuses?: string[] },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[][]> {
  if (!texts.length) return [];
  const statuses = opts.statuses ?? ["decided"];
  const vectors = await (deps.embed ?? embedDocuments)(texts.map((content) => ({ content, title: "Question" })), ctx.region).catch(() => texts.map(() => null));
  if (vectors.some(Boolean)) {
    return Promise.all(
      vectors.map((vector) => (vector ? nearestBrandMapRecords(ctx, { kind: "subject", vector, limit: opts.limit, statuses }, deps.vectors).catch(() => []) : Promise.resolve([]))),
    );
  }
  const names = (await subjectIndex(ctx, deps).catch(() => [])).filter((n) => statuses.includes(n.status));
  return texts.map((text) => {
    const words = new Set(meaningWords(text));
    return names
      .map((n) => {
        const own = meaningWords(n.name);
        return { ref: n.id, status: n.status, sim: own.length ? own.filter((w) => words.has(w)).length / own.length : 0 };
      })
      .filter((n) => n.sim > 0)
      .sort((a, b) => b.sim - a.sim || a.ref.localeCompare(b.ref))
      .slice(0, opts.limit);
  });
}

/** The buying situations nearest a piece of text (by meaning only: a brand has far fewer). */
export async function nearestSituations(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; statuses?: string[] },
  deps: EmbedDeps = {},
): Promise<BrandMapNeighbour[]> {
  const vector = await (deps.query ?? embedQuery)(text, ctx.region).catch(() => null);
  if (!vector) return [];
  return nearestBrandMapRecords(ctx, { kind: "situation", vector, limit: opts.limit, statuses: opts.statuses ?? ["decided"] }, deps.vectors).catch(() => []);
}
