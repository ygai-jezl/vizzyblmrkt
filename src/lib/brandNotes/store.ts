import { randomUUID } from "node:crypto";
import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { forTenant } from "@/lib/tenant";
import { nearestBrandMapRecords, removeBrandMapVector, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import {
  BRAND_NOTE_LIMITS,
  type BrandNote,
  type BrandNoteInput,
  type BrandNotePatch,
  type BrandNoteSource,
  type BrandNoteStatus,
} from "@/lib/types/brandNote";

/**
 * What we've seen (BRAND_NOTES_ENABLED): the brand's own first-hand notes. Each note is one
 * document in `brand_notes`; its meaning is one embedding in `brand_map_vectors` (kind `note`,
 * the same index as the brand map's subjects), so an article can find the notes close to its
 * question among hundreds. Embedding is best effort: a note without one is still listed and
 * can still be matched by the subject it is linked to.
 */

export interface NotesDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Test seams. */
  embed?: typeof embedDocuments;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

export { summariseNotes, type NotesSummary } from "./summary";

export type NotesResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const notesOf = (ctx: TenantContext, deps: NotesDeps) => forTenant(ctx, deps.db).brandNotes;
const nowIso = (deps: NotesDeps) => (deps.now ?? (() => new Date()))().toISOString();

/** A brand's notes, newest first (every one, up to the backstop). */
export async function listNotes(ctx: TenantContext, deps: NotesDeps = {}): Promise<BrandNote[]> {
  return notesOf(ctx, deps).find({ orderBy: [["createdAt", "desc"]], limit: BRAND_NOTE_LIMITS.MAX_NOTES });
}

export async function getNote(ctx: TenantContext, id: string, deps: NotesDeps = {}): Promise<BrandNote | null> {
  if (!/^bn_[a-z0-9]{8,40}$/.test(id)) return null;
  return notesOf(ctx, deps).getById(id);
}

/** Embed a note's text and store it beside the brand map's vectors (best effort). */
export async function embedNote(ctx: TenantContext, note: Pick<BrandNote, "id" | "text" | "status">, deps: NotesDeps = {}): Promise<boolean> {
  try {
    const [vector] = await (deps.embed ?? embedDocuments)([{ content: note.text, title: "What we've seen" }], ctx.region);
    if (!vector) return false;
    await writeBrandMapVector(ctx, { kind: "note", ref: note.id, status: note.status }, vector, deps.db);
    return true;
  } catch (err) {
    console.warn("[brand-notes] embedding a note failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

export interface NoteOrigin {
  source: BrandNoteSource;
  sourceRef?: string | null;
  status?: BrandNoteStatus;
  createdBy?: string | null;
}

export async function createNote(ctx: TenantContext, input: BrandNoteInput, origin: NoteOrigin, deps: NotesDeps = {}): Promise<NotesResult<BrandNote>> {
  const notes = notesOf(ctx, deps);
  if ((await notes.count()) >= BRAND_NOTE_LIMITS.MAX_NOTES) return { ok: false, status: 409, error: "too_many_notes" };
  const at = nowIso(deps);
  const id = `bn_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const note = await notes.create(id, {
    text: input.text.trim(),
    kind: input.kind,
    subjectIds: [...new Set(input.subjectIds)],
    canName: input.canName,
    source: origin.source,
    sourceRef: origin.sourceRef ?? null,
    status: origin.status ?? "kept",
    usedBy: [],
    createdBy: origin.createdBy ?? ctx.userId ?? null,
    createdAt: at,
    updatedAt: at,
  });
  await embedNote(ctx, note, deps);
  return { ok: true, value: note };
}

export async function updateNote(ctx: TenantContext, id: string, patch: BrandNotePatch, deps: NotesDeps = {}): Promise<NotesResult<BrandNote>> {
  if (!(await getNote(ctx, id, deps))) return { ok: false, status: 404, error: "not_found" };
  const updated = await notesOf(ctx, deps).claim(id, () => ({
    ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.subjectIds !== undefined ? { subjectIds: [...new Set(patch.subjectIds)] } : {}),
    ...(patch.canName !== undefined ? { canName: patch.canName } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: nowIso(deps),
  }));
  if (!updated) return { ok: false, status: 404, error: "not_found" };
  // Its meaning, or whether articles may use it, changed: the stored embedding follows.
  if (patch.text !== undefined || patch.status !== undefined) await embedNote(ctx, updated, deps);
  return { ok: true, value: updated };
}

export async function removeNote(ctx: TenantContext, id: string, deps: NotesDeps = {}): Promise<NotesResult<null>> {
  if (!(await getNote(ctx, id, deps))) return { ok: false, status: 404, error: "not_found" };
  await notesOf(ctx, deps).delete(id);
  await removeBrandMapVector(ctx, "note", id, deps.db).catch(() => undefined);
  return { ok: true, value: null };
}

/** Record that an article used these notes (`<workspaceId>/<planId>`), each once, capped. */
export async function markNotesUsed(ctx: TenantContext, ids: string[], article: string, deps: NotesDeps = {}): Promise<void> {
  const notes = notesOf(ctx, deps);
  await Promise.all(
    [...new Set(ids)].map((id) =>
      notes
        .claim(id, (n) => {
          const used = Array.isArray(n.usedBy) ? n.usedBy : [];
          if (used.includes(article)) return null;
          return { usedBy: [...used, article].slice(-BRAND_NOTE_LIMITS.MAX_USED_BY) };
        })
        .catch(() => null),
    ),
  );
}

/** Kept notes linked to any of these brand map subjects. */
export async function notesForSubjects(ctx: TenantContext, subjectIds: string[], deps: NotesDeps = {}): Promise<BrandNote[]> {
  const ids = [...new Set(subjectIds.filter(Boolean))].slice(0, 30);
  if (!ids.length) return [];
  const found = await notesOf(ctx, deps).find({ where: [["subjectIds", "array-contains-any", ids]], limit: 50 });
  return found.filter((n) => n.status === "kept");
}

/** The kept notes nearest some text in meaning, most similar first; [] when embeddings are down. */
export async function nearestNotes(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; minSim?: number },
  deps: NotesDeps = {},
): Promise<Array<{ note: BrandNote; sim: number }>> {
  const vector = await (deps.query ?? embedQuery)(text.slice(0, 2000), ctx.region).catch(() => null);
  if (!vector) return [];
  const near = await nearestBrandMapRecords(ctx, { kind: "note", vector, limit: opts.limit, statuses: ["kept"], minSim: opts.minSim }, deps.vectors).catch(
    () => [],
  );
  const notes = await Promise.all(near.map(async (n) => ({ note: await getNote(ctx, n.ref, deps), sim: n.sim })));
  return notes.filter((n): n is { note: BrandNote; sim: number } => n.note !== null && n.note.status === "kept");
}
