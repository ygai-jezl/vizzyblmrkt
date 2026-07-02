"use client";

import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { PostCard } from "./PostCard";

/** Chronological list of scheduled posts (soonest first). */
export function ListView({
  posts,
  onReschedule,
  onCancel,
  busy,
}: {
  posts: ScheduledPost[];
  onReschedule: (post: ScheduledPost, iso: string) => void;
  onCancel: (post: ScheduledPost) => void;
  busy: boolean;
}) {
  if (!posts.length) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Nothing scheduled yet. Schedule an approved item above to add it to the queue.
      </p>
    );
  }
  const sorted = [...posts].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return (
    <div className="space-y-2">
      {sorted.map((p) => (
        <PostCard key={p.id} post={p} onReschedule={onReschedule} onCancel={onCancel} busy={busy} />
      ))}
    </div>
  );
}
