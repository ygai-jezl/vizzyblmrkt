"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BlogArticleMeta, BlogBrief, BlogCrawlerCheck } from "@/lib/types/contentPlan";
import { hostOf } from "@/lib/content/blog/brief";
import { crawlerLabel } from "@/lib/content/blog/crawlers";
import { renderArticleHtml } from "@/lib/content/blog/markdown";
import { schemaScriptTag, suggestBlogSchema } from "@/lib/content/blog/schema";

/**
 * The hand-over for a blog hub. We don't host the article, so the operator carries it to
 * their own site: the three things a CMS asks for by name (title, description, slug), the
 * copy as Markdown or clean HTML, and suggested schema markup. The markup is built from
 * the article on every edit, so what is copied always mirrors what is on screen.
 */

// What a search result shows before it cuts off. Past these the count turns amber; the
// fields still take more, up to the caps the saved plan allows.
const TITLE_AIM = 60;
const DESCRIPTION_AIM = 155;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 320;
const SLUG_MAX = 120;

const LABEL = "font-medium text-neutral-600 dark:text-neutral-300";
const INPUT =
  "mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

type CopyKind = "markdown" | "html" | "schema";

/** "7 Oct 2026" */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Whether the AI answer engines' crawlers may read the article, as the site's robots.txt
 * had it when research last ran. Part of the hand-over because only whoever runs the site
 * can change it — and a page a crawler is kept out of cannot be cited at all.
 */
function CrawlerNote({ check }: { check: BlogCrawlerCheck }) {
  const site = hostOf(check.site) || check.site;
  const where = check.path && check.path !== "/" ? "this article" : "the site";
  const checked = day(check.checkedAt);
  const when = checked ? ` Checked ${checked}; research again to re-check.` : "";
  if (check.blocked.length) {
    return (
      <p role="status" className="mt-3 text-xs text-amber-700 dark:text-amber-400">
        <span className="font-medium">AI crawlers kept out.</span> robots.txt on {site} keeps{" "}
        {check.blocked.map(crawlerLabel).join(", ")} away from {where}. An answer engine that can&apos;t read the page
        can&apos;t cite it — ask whoever runs the site to let them in.{when}
      </p>
    );
  }
  return (
    <p role="status" className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
      {check.found
        ? `robots.txt on ${site} lets the AI crawlers read ${where}.`
        : `${site} has no robots.txt, so no AI crawler is kept out.`}
      {when}
    </p>
  );
}

function Count({ id, length, aim }: { id: string; length: number; aim: number }) {
  return (
    <span
      id={id}
      className={`tabular-nums ${
        length > aim ? "text-amber-700 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"
      }`}
    >
      {length} / {aim}
    </span>
  );
}

export function BlogExport({
  markdown,
  meta,
  onMetaChange,
  brief,
  pageUrl,
  brandName,
  logoUrl,
}: {
  markdown: string;
  meta: BlogArticleMeta | null | undefined;
  onMetaChange: (patch: Partial<BlogArticleMeta>) => void;
  brief: BlogBrief;
  /** The article's own URL (the plan's hub URL), or null. */
  pageUrl: string | null;
  /** The publisher when the brief names none. */
  brandName: string;
  logoUrl: string | null;
}) {
  const id = useId();
  const schema = useMemo(
    () => suggestBlogSchema({ markdown, meta, brief, pageUrl, brandName, logoUrl }),
    [markdown, meta, brief, pageUrl, brandName, logoUrl],
  );
  const [copied, setCopied] = useState<{ kind: CopyKind; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!markdown.trim()) return null;

  const metaTitle = meta?.metaTitle ?? "";
  const metaDescription = meta?.metaDescription ?? "";
  const jsonLd = schema.jsonLd;

  async function copy(kind: CopyKind, make: () => string) {
    let ok = true;
    try {
      await navigator.clipboard.writeText(make());
    } catch {
      ok = false; // blocked, or not a secure context — say so rather than pretend
    }
    setCopied({ kind, ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  }

  const copyLabel = (kind: CopyKind, idle: string) =>
    copied?.kind === kind ? (copied.ok ? "Copied ✓" : "Couldn't copy") : idle;

  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 text-xs font-semibold text-neutral-900 dark:text-neutral-100">Export</div>

      <div className="space-y-2 text-xs">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-title`} className={LABEL}>
              Meta title
            </label>
            <Count id={`${id}-title-count`} length={metaTitle.length} aim={TITLE_AIM} />
          </div>
          <input
            id={`${id}-title`}
            aria-describedby={`${id}-title-count`}
            value={metaTitle}
            onChange={(e) => onMetaChange({ metaTitle: e.target.value })}
            maxLength={TITLE_MAX}
            className={INPUT}
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-description`} className={LABEL}>
              Meta description
            </label>
            <Count id={`${id}-description-count`} length={metaDescription.length} aim={DESCRIPTION_AIM} />
          </div>
          {/* Two rows so the whole description can be read at once; it is still one line of text. */}
          <textarea
            id={`${id}-description`}
            aria-describedby={`${id}-description-count`}
            value={metaDescription}
            onChange={(e) => onMetaChange({ metaDescription: e.target.value.replace(/[\r\n]+/g, " ") })}
            rows={2}
            maxLength={DESCRIPTION_MAX}
            className={`${INPUT} leading-relaxed`}
          />
        </div>
        <div>
          <label htmlFor={`${id}-slug`} className={LABEL}>
            Slug
          </label>
          <input
            id={`${id}-slug`}
            value={meta?.slug ?? ""}
            onChange={(e) => onMetaChange({ slug: e.target.value })}
            maxLength={SLUG_MAX}
            className={`${INPUT} font-mono`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy("markdown", () => markdown)} className={BUTTON}>
          {copyLabel("markdown", "Copy Markdown")}
        </button>
        <button type="button" onClick={() => void copy("html", () => renderArticleHtml(markdown))} className={BUTTON}>
          {copyLabel("html", "Copy HTML")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (jsonLd) void copy("schema", () => schemaScriptTag(jsonLd));
          }}
          disabled={!jsonLd}
          className={BUTTON}
        >
          {copyLabel("schema", "Copy schema")}
        </button>
        {/* A button changing its own words is not announced; this is. */}
        <span role="status" className="sr-only">
          {copied ? (copied.ok ? "Copied" : "Couldn't copy") : ""}
        </span>
      </div>

      {brief.crawlers ? <CrawlerNote check={brief.crawlers} /> : null}

      <details className="mt-3 text-xs">
        <summary className={`cursor-pointer ${LABEL}`}>Suggested schema markup</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-500 dark:text-neutral-400">
          {schema.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
        {jsonLd ? (
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] leading-snug dark:border-neutral-800 dark:bg-neutral-900">
            {JSON.stringify(jsonLd, null, 2)}
          </pre>
        ) : null}
      </details>
    </div>
  );
}
