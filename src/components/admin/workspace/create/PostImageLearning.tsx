"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ImageVoteView } from "@/lib/loops/learnedView";
import { HELD_BACK_AFTER_VOTE, undoDoneLine } from "@/lib/loops/learnedWords";
import { BRAND_KIT_IMAGE_STYLE_ROUTE } from "@/lib/content/brandKit";
import { learnedAction, voteOn } from "@/components/admin/brand-kit/learnedClient";
import { VoteWhy } from "@/components/admin/brand-kit/VoteWhy";

/**
 * What Create's post image panel gains with image style versions on (learning loops step 4,
 * screen 1b): a notice when the style's look changed in the last 14 days, with See it and Undo;
 * On-brand and Off-brand under the image, calling the same vote route as the image details, with the
 * why behind the vote; and, only after a vote, whether the image was one of the about 1 in 20 made
 * without what was learned, so it can't sway the vote. The line under "Use learned brand style" is
 * the panel's own (view.standing).
 */

/** The notice above the image, while the style's newest look is under 14 days old. */
export function LookNotice({ view, onChange }: { view: ImageVoteView; onChange: () => void }) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notice = view.notice;
  if (done) {
    return (
      <p role="status" className="mb-2 rounded-md bg-neutral-50 px-2 py-1.5 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
        {done}
      </p>
    );
  }
  if (!notice) return null;
  async function undo() {
    if (!notice) return;
    setBusy(true);
    setError(null);
    const r = await learnedAction<{ restored?: number; restoredAt?: string | null; wasPerson?: boolean }>({ op: "undo", scope: notice.scope });
    setBusy(false);
    if (!r.ok) {
      setError(r.data.message ?? "Couldn't undo. Try again.");
      return;
    }
    setDone(undoDoneLine({ scope: notice.scope, restored: r.data.restored ?? 0, restoredAt: r.data.restoredAt, wasPerson: r.data.wasPerson === true, brandLook: notice.brandLook, panel: true }));
    onChange();
  }
  return (
    <div role="status" className="mb-2 flex items-start gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <Sparkles size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        {notice.text}{" "}
        <Link href={`${BRAND_KIT_IMAGE_STYLE_ROUTE}#learned`} className="font-medium underline underline-offset-2">
          See it
        </Link>
        {notice.canUndo ? (
          <>
            {" or "}
            <button type="button" disabled={busy} onClick={() => void undo()} className="font-medium underline underline-offset-2 disabled:opacity-60">
              Undo
            </button>
          </>
        ) : null}
        {error ? <span className="block text-red-700 dark:text-red-300">{error}</span> : null}
      </span>
    </div>
  );
}

/** On-brand and Off-brand under the post's image, with the why behind the vote. */
export function PostImageVotes({ view }: { view: ImageVoteView }) {
  const image = view.image;
  const [vote, setVote] = useState<"up" | "down" | null>(image?.vote ?? null);
  const [justVoted, setJustVoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!image) return null;

  async function cast(next: "up" | "down") {
    if (!image || busy) return;
    const v = vote === next ? null : next;
    setBusy(true);
    setError(null);
    const r = await voteOn(image.id, v, v === "up" ? 8 : null);
    setBusy(false);
    if (!r.ok) {
      setError(r.data.message ?? "Couldn't save your vote. Try again.");
      return;
    }
    setVote(v);
    setJustVoted(true);
  }

  const btn = "flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1 text-xs font-medium disabled:opacity-60";
  return (
    <div className="mb-2">
      <div role="group" aria-label="Your vote on this image" className="flex gap-2">
        <button
          type="button"
          aria-pressed={vote === "up"}
          disabled={busy}
          onClick={() => void cast("up")}
          className={`${btn} ${vote === "up" ? "border-green-600 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"}`}
        >
          <ThumbsUp size={14} aria-hidden /> On-brand
        </button>
        <button
          type="button"
          aria-pressed={vote === "down"}
          disabled={busy}
          onClick={() => void cast("down")}
          className={`${btn} ${vote === "down" ? "border-red-600 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"}`}
        >
          <ThumbsDown size={14} aria-hidden /> Off-brand
        </button>
      </div>
      <VoteWhy
        key={`${image.id}:${vote ?? "none"}`}
        assetId={image.id}
        vote={vote}
        reason={justVoted ? null : image.reason}
        note={justVoted ? null : image.note}
        scope={image.scope}
        startClosed={view.startClosed}
        justVoted={justVoted}
      />
      {vote && image.heldBack ? (
        <p role="status" className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
          {HELD_BACK_AFTER_VOTE}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
    </div>
  );
}
