"use client";

import { useEffect, useMemo, useState } from "react";

/** How one answer's save stands, shown under its box. */
export type AnswerSave = "saving" | "saved" | "failed";

/** What the inspector needs to save answers (BlogHubControls.answers). */
export interface SeenAnswers {
  /** The person typed: saved a second after they stop. */
  save: (id: string, text: string) => void;
  /** The person left the box: what is waiting is saved now, and its meaning embedded. */
  done: (id: string) => void;
  state: Record<string, AnswerSave>;
}

export const ANSWER_WAIT_MS = 1000;
const HEADERS = { "Content-Type": "application/json" };

export interface AnswerQueue {
  save: (id: string, text: string) => void;
  done: (id: string) => void;
  /** Finish every save: what is waiting is sent now, and what is running is waited for. */
  flush: () => Promise<void>;
  /** Leaving: what is still waiting goes now, with keepalive. The queue still works after (a page restored from the back button, or React mounting twice in development). */
  leave: () => void;
}

/**
 * The save queue behind the boxes (no React, so it can be tested): a second after the person
 * stops typing, and at once when they leave the box; one request at a time per question, always
 * with the newest text. A failed save is kept and sent again on the next keystroke or flush.
 */
export function createAnswerQueue(url: string, onState: (id: string, s: AnswerSave) => void, send: typeof fetch = fetch): AnswerQueue {
  /** Text waiting to be sent, per question; `done` once the person left the box. */
  const waiting = new Map<string, { text: string; done: boolean }>();
  /** The last text sent per question, and the ones sent while the person was still typing. */
  const sent = new Map<string, string>();
  const typing = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();

  const stopTimer = (id: string) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  };

  const run = (id: string): Promise<void> => {
    stopTimer(id);
    // One at a time: the one running sends whatever came in meanwhile when it ends.
    const current = running.get(id);
    if (current) return current;
    const next = waiting.get(id);
    if (!next) return Promise.resolve();
    waiting.delete(id);
    onState(id, "saving");
    const job = (async () => {
      let ok = false;
      try {
        const res = await send(url, { method: "PUT", headers: HEADERS, body: JSON.stringify({ noteId: id, text: next.text, done: next.done }) });
        ok = res.ok;
      } catch {
        ok = false;
      }
      running.delete(id);
      if (ok) {
        sent.set(id, next.text);
        if (next.done) typing.delete(id);
        else typing.add(id);
      } else if (!waiting.has(id)) {
        waiting.set(id, next);
      }
      if (ok && waiting.has(id)) return run(id);
      onState(id, ok ? "saved" : "failed");
    })();
    running.set(id, job);
    return job;
  };

  return {
    save(id, text) {
      const before = waiting.get(id);
      waiting.set(id, { text, done: Boolean(before?.done) });
      onState(id, "saving");
      stopTimer(id);
      timers.set(
        id,
        setTimeout(() => void run(id), ANSWER_WAIT_MS),
      );
    },
    done(id) {
      const next = waiting.get(id);
      if (next) waiting.set(id, { ...next, done: true });
      else if (typing.has(id)) waiting.set(id, { text: sent.get(id) ?? "", done: true });
      else return;
      void run(id);
    },
    async flush() {
      const ids = new Set([...waiting.keys(), ...running.keys()]);
      await Promise.all([...ids].map((id) => run(id)));
    },
    leave() {
      for (const id of timers.keys()) stopTimer(id);
      for (const [id, next] of waiting) {
        void send(url, { method: "PUT", keepalive: true, headers: HEADERS, body: JSON.stringify({ noteId: id, text: next.text, done: true }) }).catch(() => undefined);
      }
      waiting.clear();
    },
  };
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
