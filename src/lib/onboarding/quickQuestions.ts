import type { ProfileAnswers, ProfileAnswersInput } from "@/lib/types/businessProfile";
import { QUESTIONS, answerLabel, type ProfileQuestion } from "./choices";
import { QUESTIONS_WORDS } from "./words";

/**
 * The 4 quick questions as the screen shows them, worked out from where the founder is (`at`:
 * 0 to 3 is a question, 4 is the summary) and what they picked. Pure, so it is tested without a
 * browser.
 */
export interface QuestionsView {
  done: boolean;
  /** "2 of 4". */
  progress: string;
  segments: Array<"done" | "now" | "next">;
  /** Every answer picked so far, in question order, as its label. */
  soFar: string[];
  /** The question on screen (the last one on the summary). */
  question: ProfileQuestion;
  /** Back on the first question goes to the welcome; after that it stays here. */
  backToWelcome: boolean;
  /** The summary: each answer's label, or "Who you are: skipped". */
  summary: Array<{ label: string; answered: boolean }>;
}

export const QUESTION_COUNT = QUESTIONS.length;

export function questionsView(at: number, picked: ProfileAnswers): QuestionsView {
  const step = Math.max(0, Math.min(at, QUESTION_COUNT));
  const done = step >= QUESTION_COUNT;
  return {
    done,
    progress: QUESTIONS_WORDS.progress(Math.min(step + 1, QUESTION_COUNT), QUESTION_COUNT),
    segments: QUESTIONS.map((_, i) => (i < step ? "done" : i === step ? "now" : "next")),
    soFar: QUESTIONS.map((q) => answerLabel(q.key, picked[q.key])).filter(Boolean),
    question: QUESTIONS[Math.min(step, QUESTION_COUNT - 1)]!,
    backToWelcome: step === 0,
    summary: QUESTIONS.map((q) => {
      const label = answerLabel(q.key, picked[q.key]);
      return label ? { label, answered: true } : { label: QUESTIONS_WORDS.skipped(q.short), answered: false };
    }),
  };
}

/**
 * Picking option `index` (0 to 2) on question `at`: the answers after it, where to go next, and
 * what to save now. The last question saves nothing on its own: the summary's save carries every
 * answer with done.
 */
export function pick(
  at: number,
  picked: ProfileAnswers,
  index: number,
): { picked: ProfileAnswers; at: number; save: ProfileAnswersInput | null } | null {
  if (at < 0 || at >= QUESTION_COUNT) return null;
  const q = QUESTIONS[at]!;
  const option = q.options[index];
  if (!option) return null;
  const next = { ...picked, [q.key]: option.key } as ProfileAnswers;
  return { picked: next, at: at + 1, save: at + 1 < QUESTION_COUNT ? ({ [q.key]: option.key } as ProfileAnswersInput) : null };
}

/** The keys 1 to 3 pick an answer: the option's index, or null for any other key. */
export function optionForKey(key: string): number | null {
  return key === "1" || key === "2" || key === "3" ? Number(key) - 1 : null;
}

/** The save when the summary shows: every answer picked, and done. */
export function finishBody(picked: ProfileAnswers): Record<string, unknown> {
  const answers = Object.fromEntries(QUESTIONS.flatMap((q) => (picked[q.key] ? [[q.key, picked[q.key]]] : [])));
  return { ...(Object.keys(answers).length ? { answers } : {}), status: "done", via: "questions" };
}
