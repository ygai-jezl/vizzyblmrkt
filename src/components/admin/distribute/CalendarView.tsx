"use client";

import { useState } from "react";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { mondayUTC, weekDateKeys, groupPostsByDate } from "@/lib/distribute/uiModel";
import { PostCard } from "./PostCard";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * A 7-day week grid (UTC), one column per day. Posts bucket by their UTC date;
 * per-tenant local-timezone display is a later refinement (see uiModel.ts).
 */
export function CalendarView({
  posts,
  onReschedule,
  onCancel,
  onSetSpintax,
  onBuildCarousel,
  busy,
}: {
  posts: ScheduledPost[];
  onReschedule: (post: ScheduledPost, iso: string) => void;
  onCancel: (post: ScheduledPost) => void;
  onSetSpintax: (post: ScheduledPost, source: string) => void;
  onBuildCarousel: (post: ScheduledPost) => void;
  busy: boolean;
}) {
  const [weekStart, setWeekStart] = useState(() => mondayUTC(Date.now()));
  const days = weekDateKeys(weekStart);
  const byDate = groupPostsByDate(posts);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setWeekStart(weekStart - WEEK_MS)}
          className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ← Prev
        </button>
        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          {days[0]} – {days[6]} <span className="text-neutral-400">(UTC)</span>
        </span>
        <button
          type="button"
          onClick={() => setWeekStart(weekStart + WEEK_MS)}
          className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Next →
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
        {days.map((d, i) => {
          const dayPosts = byDate.get(d) ?? [];
          return (
            <div
              key={d}
              className="min-h-24 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
            >
              <div className="mb-1 text-xs font-medium text-neutral-500">
                {WEEKDAYS[i]} {d.slice(5)}
              </div>
              <div className="space-y-1">
                {dayPosts.map((p) => (
                  <PostCard
                    key={p.id}
                    post={p}
                    onReschedule={onReschedule}
                    onCancel={onCancel}
                    onSetSpintax={onSetSpintax}
                    onBuildCarousel={onBuildCarousel}
                    busy={busy}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
