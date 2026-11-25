"use client";

import { useEffect, useRef, useState } from "react";
import type { BlogArticleFreshness, BlogArticleLive } from "@/lib/types/contentPlan";

/**
 * A live article's freshness (BLOG_FRESHNESS_ENABLED), in the hub panel beside Check it's live:
 * its state, its clock and every reason, and "Checked, nothing to change", which starts the clock
 * again and never moves Updated. /help/write-and-schedule#freshness explains it.
 */

export const FRESHNESS_STATE: Record<BlogArticleFreshness["state"], { label: string; tone: string }> = {
  fresh: { label: "Fresh", tone: "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300" },
  soon: { label: "Review soon", tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  due: { label: "Due a refresh", tone: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

/** Said when a check is done. */
export const CHECKED_SAID = "Checked. The clock starts again from today, and Updated stays as it is.";
/** Said under a live article the watch hasn't looked at yet. */
export const NOT_LOOKED_YET = "YouGrow looks at live articles once a day. This one gets its clock at the next look.";

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

export function FreshnessCard({
  live,
  freshness,
  onChecked,
  disabled = false,
  focus = false,
}: {
  live: BlogArticleLive | null;
  freshness: BlogArticleFreshness | undefined;
  onChecked?: () => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  /** Scroll the card into view once, when the article was opened to look at its freshness. */
  focus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const shown = Boolean(live);
  useEffect(() => {
    if (focus && shown) ref.current?.scrollIntoView({ block: "center" });
  }, [focus, shown]);
  if (!live) return null;

  async function check() {
    if (!onChecked) return;
    setBusy(true);
    setSaid(null);
    const r = await onChecked().catch(() => ({ ok: false, error: "failed" }));
    setBusy(false);
    setSaid(r.ok ? { text: CHECKED_SAID, error: false } : { text: "That didn't save. Try again in a moment.", error: true });
  }

  return (
    <section ref={ref} id="freshness" aria-labelledby="freshness-h" className="space-y-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="freshness-h" className="text-xs font-semibold">
          Freshness
        </h3>
        {freshness ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${FRESHNESS_STATE[freshness.state].tone}`}>{FRESHNESS_STATE[freshness.state].label}</span> : null}
      </div>
      {freshness ? (
        <>
          <p className="text-neutral-600 dark:text-neutral-300">
            {freshness.arm === "test" ? `On the ${freshness.clockDays}-day clock, in the clock test` : `Every ${freshness.clockDays} days`}
            {" · "}
            {freshness.state === "due" ? `due since ${day(freshness.dueAt)}` : `due ${day(freshness.dueAt)}`}
            {freshness.checkedAt ? ` · last checked ${day(freshness.checkedAt)}` : ""}
          </p>
          {freshness.reasons.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-neutral-700 dark:text-neutral-300">
              {freshness.reasons.map((r, i) => (
                <li key={`${r.kind}-${i}`}>{r.detail}</li>
              ))}
            </ul>
          ) : null}
          {onChecked && freshness.state !== "fresh" ? (
            <button
              type="button"
              onClick={() => void check()}
              disabled={disabled || busy}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {busy ? "Saving…" : "Checked, nothing to change"}
            </button>
          ) : null}
        </>
      ) : (
        <p className="text-neutral-500 dark:text-neutral-400">{NOT_LOOKED_YET}</p>
      )}
      {said ? (
        <p role={said.error ? "alert" : "status"} className={said.error ? "text-red-700 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}>
          {said.text}
        </p>
      ) : null}
    </section>
  );
}
