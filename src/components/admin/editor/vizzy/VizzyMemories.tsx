"use client";

import { useState } from "react";
import type { VizzyLearning } from "./useVizzyLearning";

/**
 * "What Vizzy remembers about how you edit", under the Vizzy tab: each memory with Forget (and,
 * for admins, Add to brand voice), the person's "Learn from my edits" choice, Forget everything,
 * and a note for memories made since they last looked.
 */

const CARD = "rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950";
const LINK = "text-xs font-medium text-blue-700 hover:underline dark:text-blue-400";
const SMALL =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900";

const SOURCE = { learned: "Learned from your edits", asked: "You asked Vizzy to remember this" } as const;

export function VizzyMemories({ learning }: { learning: VizzyLearning }) {
  const [confirmAll, setConfirmAll] = useState(false);
  if (!learning.available) return null;
  const { memories, fresh } = learning;

  return (
    <div className="space-y-3">
      {learning.firstTime ? (
        <div role="status" className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-[13px] leading-5 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          <p>
            Vizzy learns how you like your edits from the changes you keep and undo, and uses it next time. Only you see what it
            remembers, in this brand.
          </p>
          <div className="flex gap-1.5">
            <button type="button" className={SMALL} onClick={learning.seen}>
              Got it
            </button>
            {learning.learn ? (
              <button
                type="button"
                className={SMALL}
                onClick={() => {
                  void learning.setLearn(false);
                  learning.seen();
                }}
              >
                Don&apos;t learn from my edits
              </button>
            ) : null}
          </div>
        </div>
      ) : fresh.length ? (
        <div role="status" className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-[13px] leading-5 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          <p className="font-semibold">New since last time</p>
          <ul className="space-y-1.5">
            {fresh.slice(0, 3).map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 flex-1">{m.text}</span>
                <button type="button" className={LINK} onClick={() => void learning.forget(m.id)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={SMALL} onClick={learning.seen}>
            Keep them
          </button>
        </div>
      ) : null}

      <section className={`${CARD} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">What Vizzy remembers about how you edit</h2>
          <label className="inline-flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={learning.learn}
              onChange={(e) => void learning.setLearn(e.target.checked)}
              className="h-4 w-4 accent-neutral-900 dark:accent-white"
            />
            Learn from my edits
          </label>
        </div>

        {memories.length ? (
          <ul className="space-y-2">
            {memories.map((m) => (
              <li key={m.id} className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <div className="text-sm leading-5">{m.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                  <span className="flex-1">{SOURCE[m.source]}</span>
                  {learning.canAddToBrandVoice ? (
                    <button type="button" className={LINK} onClick={() => void learning.addToBrandVoice(m.id)}>
                      Add to brand voice
                    </button>
                  ) : null}
                  <button type="button" className={LINK} onClick={() => void learning.forget(m.id)}>
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-neutral-600 dark:text-neutral-400">
            Nothing yet. Vizzy learns from the changes you keep and undo.
          </p>
        )}

        {learning.message ? (
          <p role="status" className="text-[13px] text-neutral-700 dark:text-neutral-300">
            {learning.message}
          </p>
        ) : null}

        <p className="text-xs leading-[18px] text-neutral-600 dark:text-neutral-400">
          Only you see these, in this brand. Vizzy follows your brand voice and house rules first.
          {learning.learn ? " Anything not used for 6 months is forgotten." : " Learning is off, so Vizzy doesn't use them."}
        </p>
        {learning.canAddToBrandVoice ? (
          <p className="text-xs leading-[18px] text-neutral-600 dark:text-neutral-400">
            Add to brand voice puts a rule in the Brand kit for your whole team.
          </p>
        ) : null}

        {memories.length ? (
          confirmAll ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span>Forget everything Vizzy remembers about how you edit?</span>
              <button
                type="button"
                className={SMALL}
                onClick={() => {
                  setConfirmAll(false);
                  void learning.forgetAll();
                }}
              >
                Forget everything
              </button>
              <button type="button" className={SMALL} onClick={() => setConfirmAll(false)}>
                Keep them
              </button>
            </div>
          ) : (
            <button type="button" className={SMALL} onClick={() => setConfirmAll(true)}>
              Forget everything
            </button>
          )
        ) : null}
      </section>
    </div>
  );
}
