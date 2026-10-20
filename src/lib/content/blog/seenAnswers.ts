import { z } from "zod";
import type { TenantContext } from "@/lib/tenant/types";
import { BRAND_NOTE_LIMITS, type BrandNote } from "@/lib/types/brandNote";
import { answerQuestion, askedByArticle, getNote, type NotesDeps } from "@/lib/brandNotes/store";

/**
 * An answer to one of an article's questions for its team, saved as it is typed
 * (BRAND_NOTES_QUESTIONS_ENABLED). Only a question that article asked can be answered from it:
 * anyone working on the article may answer its questions, and nothing else on What we've seen.
 */

export const SeenAnswerBodySchema = z.object({
  noteId: z.string().regex(/^bn_[a-z0-9]{8,40}$/),
  text: z.string().max(BRAND_NOTE_LIMITS.MAX_TEXT),
  /** The person left the box: the answer's meaning is embedded now. */
  done: z.boolean().default(false),
});

export type SeenAnswerResult = { status: number; body: unknown };

/** What the article's box shows once saved. */
export const answerView = (n: BrandNote) => ({ id: n.id, question: n.question ?? "", answer: n.text, status: n.status });

export async function answerForArticle(
  ctx: TenantContext,
  args: { article: string; subjectId: string | null; body: unknown },
  deps: NotesDeps = {},
): Promise<SeenAnswerResult> {
  const parsed = SeenAnswerBodySchema.safeParse(args.body);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const note = await getNote(ctx, parsed.data.noteId, deps);
  if (!note) return { status: 404, body: { error: "not_found" } };
  if (!askedByArticle(note, args.article)) return { status: 403, body: { error: "not_asked_here" } };
  const r = await answerQuestion(ctx, note.id, parsed.data.text, { subjectId: args.subjectId, done: parsed.data.done }, deps);
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  return { status: 200, body: { question: answerView(r.value) } };
}
