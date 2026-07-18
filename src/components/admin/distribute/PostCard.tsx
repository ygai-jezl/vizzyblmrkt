"use client";

import { useState } from "react";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { channelLabel } from "@/lib/content/channels";
import { formatUtc } from "@/lib/distribute/uiModel";
import { scorePPS } from "@/lib/distribute/pps";
import { PpsGauge } from "./PpsGauge";
import { SchedulePicker } from "./SchedulePicker";
import { PreviewToggle } from "./preview/PreviewToggle";
import { SpintaxToggle } from "./SpintaxToggle";
import { CarouselToggle } from "./CarouselToggle";
import { LinkedInAuthorSelect } from "./LinkedInAuthorSelect";

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
  onSetSpintax,
  onBuildCarousel,
  busy,
}: {
  post: ScheduledPost;
  onReschedule: (post: ScheduledPost, iso: string, linkedInAuthorUrn?: string | null) => void;
  onCancel: (post: ScheduledPost) => void;
  onSetSpintax: (post: ScheduledPost, source: string) => void;
  onBuildCarousel: (post: ScheduledPost) => void;
  busy: boolean;
}) {
  const isCarouselChannel = post.channel === "linkedin" || post.channel === "instagram";
  // "Post as" (LinkedIn): the org URN to publish as, or null = the connected member.
  const [author, setAuthor] = useState<string | null>(post.linkedInAuthorUrn ?? null);
  // Prefer the score persisted at schedule; fall back to a live re-score (older posts).
  const pps = post.pps ?? scorePPS(post.body, post.channel);
  // Only an un-published post can be re-timed or cancelled.
  const editable =
    (post.status === "pending" || post.status === "failed") && !post.publishedRef;

  return (
    <div className="rounded-md border border-neutral-200 p-3 text-left dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
          {channelLabel(post.channel)}
        </span>
        <div className="flex items-start gap-2">
          <PpsGauge pps={pps} />
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_STYLE[post.status] ?? STATUS_STYLE.pending
            }`}
          >
            {post.status}
          </span>
        </div>
      </div>

      <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
        {post.body}
      </p>

      <div className="mt-2 text-xs text-neutral-500">
        {formatUtc(post.scheduledAt)}
        {post.publishedRef ? ` · published (${post.publishedRef.platform})` : ""}
        {post.renderedVariant
          ? ` · variant: "${[...post.renderedVariant].slice(0, 40).join("")}${
              [...post.renderedVariant].length > 40 ? "…" : ""
            }"`
          : ""}
        {post.status === "failed" && post.lastError ? ` · ${post.lastError}` : ""}
      </div>

      {/* A successful publish can still drop its image (upload failed / asset gone) and
          degrade to text-only; lastError carries the `li_image:` note on a done post.
          Surface it distinctly — the failed-post branch above never fires for status:done. */}
      {post.status === "done" && post.lastError?.startsWith("li_image:") ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
          ⚠ image not attached — posted text-only ({post.lastError.replace(/^li_image:/, "")})
        </p>
      ) : null}

      <div className="mt-2">
        <PreviewToggle channel={post.channel} body={post.body} />
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
            onSubmit={(iso) => onReschedule(post, iso, post.channel === "linkedin" ? author : null)}
          />
          {post.channel === "linkedin" ? (
            <LinkedInAuthorSelect value={author} onChange={setAuthor} disabled={busy} />
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(post)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-red-950/30"
          >
            Cancel
          </button>
          <SpintaxToggle
            initial={post.spintaxSource ?? ""}
            busy={busy}
            onSave={(s) => onSetSpintax(post, s)}
          />
        </div>
      ) : null}

      {/* Carousel: buildable while editable, and slides stay VIEWABLE after publish. */}
      {isCarouselChannel && (editable || (post.carouselAssetRefs?.length ?? 0) > 0) ? (
        <div className="mt-2">
          <CarouselToggle
            post={post}
            busy={busy}
            canBuild={editable}
            onBuild={onBuildCarousel}
          />
        </div>
      ) : null}
    </div>
  );
}
