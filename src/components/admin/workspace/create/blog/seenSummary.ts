import { BRAND_NOTE_LIMITS } from "@/lib/types/brandNote";
import type { BlogSeen } from "@/lib/types/contentPlan";

/** What Look now found, with notes resting (BRAND_NOTES_REST_ENABLED): the notes in, the ones resting, and the questions to answer. */
export function seenSummary(seen: BlogSeen): string {
  const n = seen.notes.length;
  const r = seen.resting?.length ?? 0;
  const q = (seen.questions ?? []).filter((x) => x.answer.trim().length < BRAND_NOTE_LIMITS.MIN_TEXT).length;
  const notes = n
    ? `${n === 1 ? "One of your team's notes fits" : `${n} of your team's notes fit`} this question${r ? `, and ${r} more ${r === 1 ? "is" : "are"} resting` : ""}.`
    : r
      ? `The ${r === 1 ? "note that fits" : `${r} notes that fit`} this question ${r === 1 ? "is" : "are"} resting.`
      : "None of your team's notes fits this question closely.";
  return q ? `${notes} ${q} new ${q === 1 ? "question" : "questions"} for your team in What we've seen.` : notes;
}
