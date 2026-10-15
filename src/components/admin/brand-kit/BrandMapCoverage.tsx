"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Coverage, CoveragePage, QuestionCoverage, QuestionState } from "@/lib/content/blog/coverage";
import { Section } from "@/components/admin/connect/ui";
import { smallLabel } from "./BrandMapParts";

/** Coverage on the Brand map page (BRAND_MAP_PAGES_ENABLED): what the brand's pages answer. */

const DOT: Record<QuestionState, string> = {
  answered: "border-green-600 bg-green-600",
  drafted: "border-amber-500 bg-amber-500",
  planned: "border-amber-500 bg-transparent",
  open: "border-neutral-400 bg-transparent dark:border-neutral-500",
};

export const STATE_LABEL: Record<QuestionState, string> = { answered: "Answered", drafted: "Drafted", planned: "Planned", open: "Open" };

export function Dot({ state }: { state: QuestionState }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 ${DOT[state]}`} />;
}

/** Where a page opens: an article's plan in the app, or the page itself. */
export function pageHref(p: Pick<CoveragePage, "kind" | "workspaceId" | "planId" | "url">): string | null {
  if (p.kind === "article" && p.workspaceId && p.planId) {
    return `/admin/workspace/${encodeURIComponent(p.workspaceId)}/create/${encodeURIComponent(p.planId)}`;
  }
  return p.url && /^https:\/\//i.test(p.url) ? p.url : null;
}

export function PageLink({ page }: { page: CoveragePage }) {
  const href = pageHref(page);
  const cls = "text-blue-600 hover:underline dark:text-blue-400";
  if (!href) return <span>{page.title}</span>;
  return href.startsWith("/") ? (
    <Link href={href} className={cls}>
      {page.title}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {page.title}
    </a>
  );
}

/** At a glance: who the brand is, then a column per subject with a dot per question. */
export function CoverageStrip({ name, coverage }: { name: string; coverage: Coverage }) {
  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex gap-5 overflow-x-auto pb-1">
        <div className="w-36 shrink-0">
          <div className="text-xs text-neutral-500">Who you are</div>
          <div className="truncate text-sm font-medium" title={name}>
            {name || "Not named yet"}
          </div>
        </div>
        {coverage.subjects.map((s) => (
          <div key={s.id} className="w-36 shrink-0">
            <div className="truncate text-xs font-medium" title={s.name}>
              {s.name}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {s.questions.map((q) => (
                <span key={q.id} title={`${STATE_LABEL[q.state]}: ${q.text}`}>
                  <Dot state={q.state} />
                </span>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">
              {s.answered}/{s.questions.length} answered
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-neutral-500">
        {(Object.keys(STATE_LABEL) as QuestionState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1">
            <Dot state={state} /> {STATE_LABEL[state]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Under a question on the map: its state, and the page that answers it. */
export function QuestionStatus({ q, action }: { q: QuestionCoverage | undefined; action?: ReactNode }) {
  if (!q) return null; // a question not saved yet
  const best = q.pages[0];
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-neutral-500 dark:text-neutral-400">
      <Dot state={q.state} />
      <span>{STATE_LABEL[q.state]}</span>
      {best ? (
        <>
          <span aria-hidden>·</span>
          <PageLink page={best} />
          {q.pages.length > 1 ? <span>and {q.pages.length - 1} more</span> : null}
        </>
      ) : q.probably ? (
        <>
          <span aria-hidden>·</span>
          <span>
            probably answered by <PageLink page={q.probably} />
          </span>
        </>
      ) : null}
      {q.state === "open" && action ? <span className="ml-1">{action}</span> : null}
    </div>
  );
}

/** Pages that answer the same main question, and older pages that should link to a newer one. */
export function NeedsALook({ coverage }: { coverage: Coverage }) {
  const { overlaps, missingLinks } = coverage;
  if (!overlaps.length && !missingLinks.length) return null;
  return (
    <Section title="Needs a look">
      {overlaps.length ? (
        <div className="space-y-1.5">
          <span className={smallLabel}>Same main question</span>
          <ul className="space-y-2 text-sm">
            {overlaps.map((o) => (
              <li key={o.pages.map((p) => p.id).join("|")} className="space-y-0.5">
                <div className="text-neutral-700 dark:text-neutral-300">“{o.question}”</div>
                <div className="flex flex-wrap gap-x-2 text-xs">
                  {o.pages.map((p) => (
                    <PageLink key={p.id} page={p} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {missingLinks.length ? (
        <div className="space-y-1.5">
          <span className={smallLabel}>Should link to a newer page</span>
          <ul className="space-y-1 text-xs">
            {missingLinks.map((m) => (
              <li key={`${m.from.id}>${m.to.id}`}>
                <PageLink page={m.from} /> <span aria-label="should link to">→</span> <PageLink page={m.to} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
