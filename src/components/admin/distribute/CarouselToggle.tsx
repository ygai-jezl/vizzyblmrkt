/* eslint-disable @next/next/no-img-element */
"use client";

import { useState } from "react";
import type { ScheduledPost } from "@/lib/types/scheduledPost";

/**
 * Carousel builder for a LinkedIn/Instagram post: shows the generated slide
 * thumbnails (served by the authenticated workspace asset proxy) and a button to
 * (re)generate them. Flag-gated server-side — a disabled build surfaces as a
 * friendly error via the parent.
 */
export function CarouselToggle({
  post,
  busy,
  canBuild,
  onBuild,
}: {
  post: ScheduledPost;
  busy: boolean;
  /** false once the post is publishing/published — slides stay VIEWABLE, no (re)build. */
  canBuild: boolean;
  onBuild: (post: ScheduledPost) => void;
}) {
  const [open, setOpen] = useState(false);
  const refs = post.carouselAssetRefs ?? [];
  const assetUrl = (f: string) => `/api/admin/workspace/${post.workspaceId}/asset/${f}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-neutral-500 underline-offset-2 hover:underline"
        aria-expanded={open}
      >
        {open ? "Hide carousel" : refs.length ? `Carousel · ${refs.length} slides` : "Build carousel"}
      </button>
      {open ? (
        <div className="mt-2 max-w-md space-y-2">
          {refs.length ? (
            <div className="flex flex-wrap gap-2">
              {refs.map((f, i) => (
                <img
                  key={f}
                  src={assetUrl(f)}
                  alt={`Slide ${i + 1}`}
                  className="h-24 w-24 rounded border border-neutral-200 object-cover dark:border-neutral-800"
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-neutral-500">
              Generate square slide images from this post&apos;s copy (LinkedIn / Instagram carousel).
            </p>
          )}
          {canBuild ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBuild(post)}
              className="rounded bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              {refs.length ? "Regenerate slides" : "Generate slides"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
