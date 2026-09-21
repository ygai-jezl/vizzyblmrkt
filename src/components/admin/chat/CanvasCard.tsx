"use client";

import Link from "next/link";
import { ArrowUpRight, Workflow } from "lucide-react";
import type { CanvasCardData } from "./useDashboardChat";

/**
 * A draft an agent just saved on a canvas — shown under its chat message with
 * the headline numbers and an "Open canvas" link. Drafts only: nothing sends
 * until a human publishes from the canvas.
 */
export function CanvasCard({ card }: { card: CanvasCardData }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          <Workflow size={16} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{card.title}</div>
          <div className="text-xs text-neutral-500">
            {[card.subtitle, ...card.stats.map((s) => `${s.value} ${s.label}`)].filter(Boolean).join(" · ")}
            {card.warnings > 0 ? (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                · {card.warnings} {card.warnings === 1 ? "thing" : "things"} to fix
              </span>
            ) : null}
          </div>
          <div className="text-xs text-neutral-400">Draft — nothing sends until you publish.</div>
        </div>
      </div>
      <Link
        href={card.url}
        className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Open canvas <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}
