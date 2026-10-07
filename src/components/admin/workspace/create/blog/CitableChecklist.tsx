"use client";

import { useMemo } from "react";
import type { BlogArticleMeta, BlogBrief } from "@/lib/types/contentPlan";
import { CITABLE_LETTERS, evaluateCitable, type CitableStatus } from "@/lib/content/blog/citable";

/**
 * The CITABLE check, live in the inspector: the same evaluateCitable the server runs after
 * writing, re-read on every edit so the score moves as the operator fixes the copy. Under
 * it, what the fact check did to the copy — the sentences it changed, the figures it could
 * not trace, the links it took out. The check reads structure; whether the article is TRUE
 * is still a person's call, so those are listed here rather than folded into the score.
 */

const MARK: Record<CitableStatus, { glyph: string; says: string; cls: string }> = {
  pass: { glyph: "✓", says: "Passed", cls: "text-emerald-600 dark:text-emerald-400" },
  warn: { glyph: "!", says: "Partly there", cls: "text-amber-600 dark:text-amber-400" },
  fail: { glyph: "✕", says: "Not met", cls: "text-red-600 dark:text-red-400" },
};

const HEADING = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
const MUTED = "text-neutral-500 dark:text-neutral-400";
const DIVIDED = "mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800";

export function CitableChecklist({
  markdown,
  brief,
  meta,
  pageUrl,
}: {
  markdown: string;
  brief: BlogBrief;
  /** The hub node's article meta — what the fact check found. */
  meta?: BlogArticleMeta | null;
  /** The article's own URL (the plan's hub URL), so links to it count as the brand's own. */
  pageUrl: string | null;
}) {
  const report = useMemo(
    () => (markdown.trim() ? evaluateCitable(markdown, { brief, meta, pageUrl }) : null),
    [markdown, brief, meta, pageUrl],
  );
  if (!report) return null;

  const corrections = meta?.corrections ?? [];
  // From the report, not the meta: a figure the operator has since edited out stops showing.
  const figures = report.figuresToCheck;
  const removedLinks = meta?.removedLinks ?? [];

  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">CITABLE check</div>
        <div className={`text-xs ${MUTED}`}>
          <span className="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
            {report.score}
          </span>{" "}
          / 100
        </div>
      </div>

      <div className="mt-2 space-y-2.5">
        {CITABLE_LETTERS.map(({ letter, name }) => {
          const items = report.items.filter((it) => it.letter === letter);
          if (!items.length) return null;
          return (
            <div key={letter}>
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-700 dark:text-neutral-200">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-neutral-900 text-[11px] font-semibold text-white dark:bg-white dark:text-neutral-900">
                  {letter}
                </span>
                {name}
              </div>
              <ul className="mt-1 space-y-1 pl-7">
                {items.map((it) => (
                  <li key={it.id} className="flex gap-2 text-xs leading-snug">
                    <span className={`w-3 shrink-0 text-center font-bold ${MARK[it.status].cls}`} title={MARK[it.status].says}>
                      <span aria-hidden>{MARK[it.status].glyph}</span>
                      <span className="sr-only">{MARK[it.status].says}:</span>
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{it.label}</span>{" "}
                      <span className={MUTED}>{it.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {corrections.length ? (
        <div className={DIVIDED}>
          <div className={HEADING}>Changed by the fact check</div>
          <ul className="mt-1.5 space-y-2">
            {corrections.map((c, i) => (
              <li key={i} className="text-xs leading-snug">
                <del className={`block line-through ${MUTED}`}>{c.before}</del>
                <div className="mt-0.5 text-neutral-800 dark:text-neutral-200">
                  {c.after.trim() ? c.after : <span className={`italic ${MUTED}`}>(taken out)</span>}
                </div>
                {c.reason ? <div className={`mt-0.5 ${MUTED}`}>Why: {c.reason}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {figures.length ? (
        <div className={DIVIDED}>
          <div className={HEADING}>Figures to check</div>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {figures.map((figure, i) => (
              <li
                key={i}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              >
                {figure}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {removedLinks.length ? (
        <div className={DIVIDED}>
          <div className={HEADING}>Links taken out</div>
          {/* Plain text on purpose: these were taken out because nobody vouched for them. */}
          <ul className={`mt-1.5 space-y-1 text-xs ${MUTED}`}>
            {removedLinks.map((link, i) => (
              <li key={i} className="break-all">
                {link}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
