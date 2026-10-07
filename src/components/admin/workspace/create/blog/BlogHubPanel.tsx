"use client";

import { BlogArticleMetaSchema, type BlogArticleMeta, type ContentNode } from "@/lib/types/contentPlan";
import { BlogBriefPanel } from "./BlogBriefPanel";
import { BlogExport } from "./BlogExport";
import { CitableChecklist } from "./CitableChecklist";
import type { BlogHubControls } from "./types";

/**
 * What the inspector adds for a blog hub written to the CITABLE structure, in the two
 * places the work happens: the brief ABOVE the copy (what the article may say, link to
 * and cite — settled before it is written), and the review BELOW it (the fact check, the
 * CITABLE check and the hand-over — read once it is).
 */

/** "7 Oct 2026, 14:32" — with the time, so a check that was just re-run visibly moves. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BlogHubBrief({ controls, disabled }: { controls: BlogHubControls; disabled?: boolean }) {
  return (
    <div className="mb-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 text-xs font-semibold text-neutral-900 dark:text-neutral-100">Blog brief</div>
      <BlogBriefPanel controls={controls} disabled={disabled} />
    </div>
  );
}

export function BlogHubReview({
  node,
  controls,
  onUpdate,
  disabled,
}: {
  node: ContentNode;
  controls: BlogHubControls;
  onUpdate: (patch: Partial<ContentNode>) => void;
  disabled?: boolean;
}) {
  // Nothing to check or hand over until there is copy.
  if (!node.body.trim()) return null;

  const checkedAt = node.blog?.checkedAt ?? null;
  // The node's meta is null until the writer or a check fills it in, so an edit made
  // before then starts from the schema's own defaults.
  const onMetaChange = (patch: Partial<BlogArticleMeta>) =>
    onUpdate({ blog: { ...(node.blog ?? BlogArticleMetaSchema.parse({})), ...patch } });

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => controls.onCheckFacts()}
          disabled={disabled || controls.busy !== null}
          title="Check the copy's claims against your own material and the checked sources"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {controls.busy === "check" ? "Checking…" : "Check facts"}
        </button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {checkedAt ? `Facts checked ${when(checkedAt)}`.trim() : "Not fact-checked yet"}
        </span>
      </div>
      {/* How the last check went (or why it didn't run), beside the button that ran it. */}
      {controls.noteFor === "check" && controls.note ? (
        <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
          {controls.note}
        </p>
      ) : null}

      <CitableChecklist markdown={node.body} brief={controls.brief} meta={node.blog} pageUrl={controls.pageUrl} />

      {/* A rewrite or a fact check hands back new meta, so the fields wait while one runs
          rather than take an edit that would be overwritten. */}
      <fieldset disabled={disabled || controls.busy === "check"} aria-label="Export" className="min-w-0">
        <BlogExport
          markdown={node.body}
          meta={node.blog}
          onMetaChange={onMetaChange}
          brief={controls.brief}
          pageUrl={controls.pageUrl}
          brandName={controls.brandName}
          logoUrl={controls.logoUrl}
        />
      </fieldset>
    </div>
  );
}
