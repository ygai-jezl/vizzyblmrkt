"use client";

import { useState } from "react";
import type { DraftChangeView } from "@/lib/distribute/postExtras";

/**
 * What the person changed from Vizzy's draft of a post (CONTENT_AI_DRAFT_KEPT_ENABLED): a line
 * that opens the changes, taken out words struck through and new words highlighted.
 */
export function DraftChanges({
  draft,
  published,
  learningOn,
}: {
  draft: DraftChangeView;
  published: boolean;
  learningOn: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!draft.changed) {
    return (
      <p className="text-xs text-neutral-500">{published ? "Posted as Vizzy wrote it." : "Same as Vizzy's draft."}</p>
    );
  }
  const words = `${draft.words} ${draft.words === 1 ? "word" : "words"}`;
  return (
    <div className="text-xs">
      <p className="text-neutral-500">
        You changed {words} from Vizzy&apos;s draft.{" "}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="font-medium text-blue-700 hover:underline dark:text-blue-400"
        >
          {open ? "Hide changes" : "Show changes"}
        </button>
      </p>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          <p className="whitespace-pre-wrap rounded bg-neutral-50 p-2 leading-5 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
            {draft.segments.map((s, i) =>
              s.op === "del" ? (
                <del key={i} className="bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200">
                  {s.text}
                </del>
              ) : s.op === "ins" ? (
                <ins key={i} className="bg-green-100 text-green-900 no-underline dark:bg-green-950/60 dark:text-green-200">
                  {s.text}
                </ins>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
          {learningOn ? (
            <p className="text-neutral-500">
              Vizzy learns from changes like these once a post is published, and uses them in your next drafts.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
