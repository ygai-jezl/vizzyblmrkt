"use client";

import { useEffect, useMemo, useState } from "react";
import { createAnswerQueue, type AnswerQueue, type AnswerSave } from "@/lib/brandNotes/answerQueue";

export type { AnswerSave } from "@/lib/brandNotes/answerQueue";

/** What the inspector needs to save answers (BlogHubControls.answers). */
export interface SeenAnswers {
  /** The person typed: saved a second after they stop. */
  save: (id: string, text: string) => void;
  /** The person left the box: what is waiting is saved now, and its meaning embedded. */
  done: (id: string) => void;
  state: Record<string, AnswerSave>;
}

const NOOP: AnswerQueue = { save: () => {}, done: () => {}, flush: async () => {}, leave: () => {} };

/**
 * Answers to an article's questions for its team, saved as they are typed
 * (BRAND_NOTES_QUESTIONS_ENABLED). The canvas owns it, so a save outlives the inspector,
 * `flush` finishes every save before the canvas saves the plan or runs a step, and leaving the
 * page (or the canvas) sends what is left. `url` null: nothing is saved.
 */
export function useSeenAnswers(url: string | null): SeenAnswers & { flush: () => Promise<void> } {
  const [state, setState] = useState<Record<string, AnswerSave>>({});
  const queue = useMemo(
    () => (url ? createAnswerQueue(url, (id, s) => setState((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }))) : NOOP),
    [url],
  );
  useEffect(() => {
    window.addEventListener("pagehide", queue.leave);
    return () => {
      window.removeEventListener("pagehide", queue.leave);
      queue.leave();
    };
  }, [queue]);
  return { save: queue.save, done: queue.done, flush: queue.flush, state };
}
