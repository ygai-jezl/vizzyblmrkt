"use client";

import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { channelLabel } from "@/lib/content/channels";
import { formatUtc } from "@/lib/distribute/uiModel";
import { SchedulePicker } from "./SchedulePicker";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  processing: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  done: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

/** Convert a UTC ISO instant to a `datetime-local` value in the browser's timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function PostCard({
  post,
  onReschedule,
  onCancel,
  busy,
}: {
  post: ScheduledPost;
  onReschedule: (post: ScheduledPost, iso: string) => void;
  onCancel: (post: ScheduledPost) => void;
  busy: boolean;
}) {
  // Only an un-published post can be re-timed or cancelled.
  const editable =
    (post.status === "pending" || post.status === "failed") && !post.publishedRef;

  return (
    <div className="rounded-md border border-neutral-200 p-3 text-left dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
          {channelLabel(post.channel)}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_STYLE[post.status] ?? STATUS_STYLE.pending
          }`}
        >
          {post.status}
        </span>
      </div>

      <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
        {post.body}
      </p>

      <div className="mt-2 text-xs text-neutral-500">
        {formatUtc(post.scheduledAt)}
        {post.publishedRef ? ` · published (${post.publishedRef.platform})` : ""}
        {post.status === "failed" && post.lastError ? ` · ${post.lastError}` : ""}
      </div>

      {editable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SchedulePicker
            // Remount when the time changes so the input resets to the new value
            // after a successful reschedule (the initializer only reads `initial` once).
            key={post.scheduledAt}
            label="Reschedule"
            initial={toLocalInput(post.scheduledAt)}
            disabled={busy}
            onSubmit={(iso) => onReschedule(post, iso)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(post)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-red-950/30"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
