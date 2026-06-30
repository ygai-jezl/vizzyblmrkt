"use client";

import type { TemplatePlaceholder } from "@/lib/types/template";
import { reconcilePlaceholders } from "@/lib/content/placeholders";

/** The structured variables of a template. Lazy-derives from the body for pre-v2
 *  templates that have no stored placeholders. */
export function PlaceholderList({
  body,
  placeholders,
}: {
  body: string;
  placeholders: TemplatePlaceholder[];
}) {
  const list = placeholders.length ? placeholders : reconcilePlaceholders(body, []);
  if (!list.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Variables ({list.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {list.map((p) => (
          <span
            key={p.token}
            title={p.hint ?? p.label}
            className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {`{{${p.token}}}`}
            <span className="text-neutral-400">
              {" · "}
              {p.kind}
              {p.repeatable ? " · ↻" : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
