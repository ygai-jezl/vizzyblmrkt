"use client";

import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { CalendarNewsletter } from "@/lib/distribute/uiModel";
import { PostCard } from "./PostCard";
import { NewsletterChip } from "./NewsletterChip";

/** Chronological list of scheduled posts + weekly newsletters (soonest first). */
export function ListView({
  posts,
  newsletters,
  onReschedule,
  onCancel,
  onSetSpintax,
  onBuildCarousel,
  busy,
}: {
  posts: ScheduledPost[];
  newsletters: CalendarNewsletter[];
  onReschedule: (post: ScheduledPost, iso: string) => void;
  onCancel: (post: ScheduledPost) => void;
  onSetSpintax: (post: ScheduledPost, source: string) => void;
  onBuildCarousel: (post: ScheduledPost) => void;
  busy: boolean;
}) {
  if (!posts.length && !newsletters.length) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Nothing scheduled yet. Schedule an approved item above, or send a weekly newsletter, to add it to the queue.
      </p>
    );
  }
  // Interleave posts + newsletters by date (soonest first) so newsletters read
  // "amongst other content".
  const rows = [
    ...posts.map((p) => ({ key: `p:${p.id}`, dateIso: p.scheduledAt, post: p, nl: null as null })),
    ...newsletters.map((n) => ({ key: `n:${n.id}`, dateIso: n.dateIso, post: null as null, nl: n })),
  ].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  return (
    <div className="space-y-2">
      {rows.map((r) =>
        r.post ? (
          <PostCard
            key={r.key}
            post={r.post}
            onReschedule={onReschedule}
            onCancel={onCancel}
            onSetSpintax={onSetSpintax}
            onBuildCarousel={onBuildCarousel}
            busy={busy}
          />
        ) : (
          <NewsletterChip key={r.key} item={r.nl!} />
        ),
      )}
    </div>
  );
}
