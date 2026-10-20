import { randomUUID } from "node:crypto";
import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { forTenant } from "@/lib/tenant";
import { nearestBrandMapRecords, removeBrandMapVector, setBrandMapVectorStatus, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import {
  BRAND_NOTE_LIMITS,
  type BrandNote,
  type BrandNoteInput,
  type BrandNotePatch,
  type BrandNoteSource,
  type BrandNoteStatus,
  type NoteArticle,
} from "@/lib/types/brandNote";
import { suggestKind } from "./prompts";

/**
 * What we've seen (BRAND_NOTES_ENABLED): the brand's own first-hand notes. Each note is one
 * document in `brand_notes`; its meaning is one embedding in `brand_map_vectors` (kind `note`,
 * the same index as the brand map's subjects), so an article can find the notes close to its
 * question among hundreds. Embedding is best effort: a note without one is still listed and
 * can still be matched by the subject it is linked to.
 *
 * Open questions (BRAND_NOTES_QUESTIONS_ENABLED): a question an article asked its team is a note
 * of its own (source `question`, status `asked`, no text), linked to every article that asked it.
 * Its question is embedded apart (kind `question`) so another article can find and reuse it.
 * Answered, it becomes a kept note like any other, embedded with its question.
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

/** Embed a note's text (after the question it answers, if any) beside the brand map's vectors (best effort). */
export async function embedNote(
  ctx: TenantContext,
  note: Pick<BrandNote, "id" | "text" | "status"> & { question?: string | null },
  deps: NotesDeps = {},
): Promise<boolean> {
  try {
    const content = [note.question, note.text].filter((s) => s?.trim()).join("\n");
    const [vector] = await (deps.embed ?? embedDocuments)([{ content, title: "What we've seen" }], ctx.region);
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
  const current = await getNote(ctx, id, deps);
  if (!current) return { ok: false, status: 404, error: "not_found" };
  // An open question is kept by answering it, never empty.
  const open = current.status === "asked";
  if (open && patch.text === undefined && patch.status !== undefined) return { ok: false, status: 409, error: "unanswered_question" };
  const answering = open && patch.text !== undefined;
  const at = nowIso(deps);
  const updated = await notesOf(ctx, deps).claim(id, () => ({
    ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.subjectIds !== undefined ? { subjectIds: [...new Set(patch.subjectIds)] } : {}),
    ...(patch.canName !== undefined ? { canName: patch.canName } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(answering ? { status: "kept" as const, answeredBy: ctx.userId ?? null, answeredAt: at } : {}),
    updatedAt: at,
  }));
  if (!updated) return { ok: false, status: 404, error: "not_found" };
  if (answering) await setBrandMapVectorStatus(ctx, { kind: "question", ref: id, status: "answered" }, deps.db).catch(() => undefined);
  // Its meaning, or whether articles may use it, changed: the stored embedding follows.
  if (updated.status !== "asked" && (patch.text !== undefined || patch.status !== undefined)) await embedNote(ctx, updated, deps);
  return { ok: true, value: updated };
}

export async function removeNote(ctx: TenantContext, id: string, deps: NotesDeps = {}): Promise<NotesResult<null>> {
  if (!(await getNote(ctx, id, deps))) return { ok: false, status: 404, error: "not_found" };
  await notesOf(ctx, deps).delete(id);
  await removeBrandMapVector(ctx, "note", id, deps.db).catch(() => undefined);
  await removeBrandMapVector(ctx, "question", id, deps.db).catch(() => undefined);
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

/** The kept notes nearest some text in meaning (or a query vector already made from it), most similar first; [] when embeddings are down. */
export async function nearestNotes(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; minSim?: number; vector?: number[] | null },
  deps: NotesDeps = {},
): Promise<Array<{ note: BrandNote; sim: number }>> {
  const vector = opts.vector ?? (await (deps.query ?? embedQuery)(text.slice(0, 2000), ctx.region).catch(() => null));
  if (!vector) return [];
  const near = await nearestBrandMapRecords(ctx, { kind: "note", vector, limit: opts.limit, statuses: ["kept"], minSim: opts.minSim }, deps.vectors).catch(
    () => [],
  );
  const notes = await Promise.all(near.map(async (n) => ({ note: await getNote(ctx, n.ref, deps), sim: n.sim })));
  return notes.filter((n): n is { note: BrandNote; sim: number } => n.note !== null && n.note.status === "kept");
}

/** Questions aren't saved when the brand is this close to its backstop: room stays for real notes. */
export const QUESTION_HEADROOM = 200;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const asArticle = (a: NoteArticle): NoteArticle => ({
  ref: a.ref.slice(0, 200),
  title: oneLine(a.title).slice(0, BRAND_NOTE_LIMITS.MAX_ARTICLE_TITLE),
});

/** Embed open questions' questions in one call (best effort), each searched by whether it is answered. */
async function embedQuestions(ctx: TenantContext, notes: BrandNote[], deps: NotesDeps): Promise<void> {
  if (!notes.length) return;
  try {
    const vectors = await (deps.embed ?? embedDocuments)(
      notes.map((n) => ({ content: n.question ?? "", title: "A question for the team" })),
      ctx.region,
    );
    await Promise.all(
      notes.map((n, i) => {
        const v = vectors[i];
        return v ? writeBrandMapVector(ctx, { kind: "question", ref: n.id, status: n.status === "asked" ? "asked" : "answered" }, v, deps.db) : null;
      }),
    );
  } catch (err) {
    console.warn("[brand-notes] embedding questions failed", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

/**
 * Keep an article's questions for its team as open questions, linked to it. [] when the brand is
 * near its backstop: the article still shows them, they just aren't kept.
 */
export async function askQuestions(
  ctx: TenantContext,
  args: { questions: string[]; article: NoteArticle },
  deps: NotesDeps = {},
): Promise<BrandNote[]> {
  const notes = notesOf(ctx, deps);
  const questions = [...new Set(args.questions.map((q) => oneLine(q).slice(0, BRAND_NOTE_LIMITS.MAX_QUESTION)).filter(Boolean))];
  if (!questions.length) return [];
  if ((await notes.count()) + questions.length > BRAND_NOTE_LIMITS.MAX_NOTES - QUESTION_HEADROOM) return [];
  const at = nowIso(deps);
  const made = await Promise.all(
    questions.map((question) =>
      notes.create(`bn_${randomUUID().replace(/-/g, "").slice(0, 24)}`, {
        text: "",
        kind: suggestKind(question),
        subjectIds: [],
        canName: false,
        source: "question",
        sourceRef: null,
        status: "asked",
        usedBy: [],
        question,
        askedFor: [asArticle(args.article)],
        answeredBy: null,
        answeredAt: null,
        createdBy: ctx.userId ?? null,
        createdAt: at,
        updatedAt: at,
      }),
    ),
  );
  await embedQuestions(ctx, made, deps);
  return made;
}

/** Link an open question to one more article that asked it (once each, capped). */
export async function addAskedFor(ctx: TenantContext, id: string, article: NoteArticle, deps: NotesDeps = {}): Promise<BrandNote | null> {
  const linked = asArticle(article);
  const done = await notesOf(ctx, deps)
    .claim(id, (n) => {
      const list = Array.isArray(n.askedFor) ? n.askedFor : [];
      if (n.source !== "question" || list.some((a) => a.ref === linked.ref)) return null;
      return { askedFor: [...list, linked].slice(-BRAND_NOTE_LIMITS.MAX_ASKED_FOR), updatedAt: nowIso(deps) };
    })
    .catch(() => null);
  return done ?? getNote(ctx, id, deps);
}

/** Whether an article asked this question (so a person working on it may answer it). */
export const askedByArticle = (note: Pick<BrandNote, "source" | "askedFor">, ref: string): boolean =>
  note.source === "question" && (note.askedFor ?? []).some((a) => a.ref === ref);

/**
 * Answer an open question, or change or clear its answer. With 12 characters or more it is a kept
 * note (its kind suggested from the answer the first time, and linked to the article's subject);
 * cleared, it is an open question again. The answer's meaning is embedded when the person is done
 * typing (`done`) or when it first becomes a note, never on every keystroke.
 */
export async function answerQuestion(
  ctx: TenantContext,
  id: string,
  text: string,
  opts: { subjectId?: string | null; done?: boolean } = {},
  deps: NotesDeps = {},
): Promise<NotesResult<BrandNote>> {
  const current = await getNote(ctx, id, deps);
  if (!current || current.source !== "question") return { ok: false, status: 404, error: "not_found" };
  const answer = text.trim().slice(0, BRAND_NOTE_LIMITS.MAX_TEXT);
  const answered = answer.length >= BRAND_NOTE_LIMITS.MIN_TEXT;
  const wasOpen = current.status === "asked";
  const at = nowIso(deps);
  const updated = await notesOf(ctx, deps).claim(id, (n) => {
    const opening = n.status === "asked" && answered;
    return {
      text: answer,
      status: answered ? "kept" : "asked",
      ...(opening ? { kind: suggestKind(answer), subjectIds: opts.subjectId ? [opts.subjectId] : n.subjectIds ?? [] } : {}),
      ...(!answered ? { subjectIds: [] } : {}),
      ...(answered ? { answeredBy: ctx.userId ?? null, answeredAt: at } : {}),
      updatedAt: at,
    };
  });
  if (!updated) return { ok: false, status: 404, error: "not_found" };
  if (wasOpen !== !answered) {
    await setBrandMapVectorStatus(ctx, { kind: "question", ref: id, status: answered ? "answered" : "asked" }, deps.db).catch(() => undefined);
  }
  if (!answered) await removeBrandMapVector(ctx, "note", id, deps.db).catch(() => undefined);
  else if (wasOpen || opts.done) await embedNote(ctx, updated, deps);
  return { ok: true, value: updated };
}

/** Open questions close in meaning to a query vector, most similar first, leaving out some ids. */
export async function nearestOpenQuestions(
  ctx: TenantContext,
  vector: number[],
  opts: { limit: number; minSim?: number; exclude?: Iterable<string> },
  deps: NotesDeps = {},
): Promise<Array<{ note: BrandNote; sim: number }>> {
  const exclude = new Set(opts.exclude ?? []);
  const near = await nearestBrandMapRecords(
    ctx,
    { kind: "question", vector, limit: opts.limit + exclude.size, statuses: ["asked"], minSim: opts.minSim },
    deps.vectors,
  ).catch(() => []);
  const found = await Promise.all(near.filter((n) => !exclude.has(n.ref)).map(async (n) => ({ note: await getNote(ctx, n.ref, deps), sim: n.sim })));
  return found.filter((n): n is { note: BrandNote; sim: number } => n.note?.status === "asked").slice(0, opts.limit);
}

/** Notes by id, in the order asked; one that is gone (or another brand's) is left out. */
export async function notesById(ctx: TenantContext, ids: string[], deps: NotesDeps = {}): Promise<BrandNote[]> {
  const found = await Promise.all([...new Set(ids)].slice(0, 20).map((id) => getNote(ctx, id, deps).catch(() => null)));
  return found.filter((n): n is BrandNote => n !== null);
}
