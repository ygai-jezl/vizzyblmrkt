"use client";

import { useEffect, useRef, useState } from "react";
import type { ArticleReviewDoc, ReviewEvidence, ReviewProposal } from "@/lib/types/articleRefresh";
import { evidenceLine, KIND_SAID, STEP_SAID } from "@/lib/content/blog/refreshWords";

export { evidenceLine, KIND_SAID, STEP_SAID };

/**
 * A live article's refresh review (BLOG_REFRESH_ENABLED), in the hub panel under Freshness:
 * Review for refresh, a line while its five steps run (the open article moves them on), then
 * each proposed change with its evidence, ticked or not, and Apply or Dismiss. Nothing changes
 * the copy until a person applies. /help/write-and-schedule#refresh explains it.
 */

export const NOTHING_SAID = "The review found nothing worth changing. The clock starts again, and Updated stays as it is.";
export const REAL_UPDATE_SAID = "A real update: Updated becomes today and Published stays. The copy now is kept as a version, and the article goes back to you to approve.";
export const LINKS_ONLY_SAID = "Link fixes only: Updated stays, and the clock starts again. The copy now is kept as a version.";
export const APPLIED_SAID = (n: number, real: boolean) =>
  `Applied ${n} change${n === 1 ? "" : "s"}. ${real ? "Updated is today." : "Updated stays as it is."} The article is back with you to approve.`;
export const DISMISSED_SAID = "Dismissed. None of these comes back on this article, and the clock starts again.";

const START_ERRORS: Record<string, string> = {
  not_included: "Refresh reviews aren't included in this brand's plan.",
  monthly_limit: "This brand has used its refresh reviews for this month.",
  rate_limited: "Too many reviews at once. Try again in a few minutes.",
  not_live: "Mark the article live first: a review looks at the live page.",
  autopilot_running: "The autopilot is writing this article. Take over first.",
};

export type RefreshAction = { action: "start" | "step" | "stop" | "dismiss" } | { action: "apply"; ids: string[] };
export interface RefreshAnswer {
  review?: ArticleReviewDoc | null;
  error?: string;
  applied?: number;
  skipped?: number;
  real?: boolean;
}

export interface RefreshControls {
  read: (nodeId: string) => Promise<ArticleReviewDoc | null>;
  /** Posts the action; the canvas saves first for Apply and takes back the node it returns. */
  act: (nodeId: string, body: RefreshAction) => Promise<RefreshAnswer>;
}

export function RefreshReviewCard({ nodeId, controls, disabled = false, onAnswer }: { nodeId: string; controls: RefreshControls; disabled?: boolean; onAnswer?: () => void }) {
  const [review, setReview] = useState<ArticleReviewDoc | null | undefined>(undefined);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const latest = useRef(controls);
  latest.current = controls;

  useEffect(() => {
    let gone = false;
    void latest.current.read(nodeId).then((r) => {
      if (gone) return;
      setReview(r);
      if (r?.state === "ready") setTicked(new Set(r.proposals.filter((p) => p.ticked).map((p) => p.id)));
    });
    return () => {
      gone = true;
    };
  }, [nodeId]);

  // While a review runs and the article is open, move it on step by step.
  const running = Boolean(review?.active);
  useEffect(() => {
    if (!running) return;
    let gone = false;
    void (async () => {
      while (!gone) {
        const before = Date.now();
        const a = await latest.current.act(nodeId, { action: "step" }).catch(() => ({}) as RefreshAnswer);
        if (gone) return;
        if (a.review) {
          setReview(a.review);
          if (!a.review.active) {
            if (a.review.state === "ready") setTicked(new Set(a.review.proposals.filter((p) => p.ticked).map((p) => p.id)));
            if (a.review.state === "nothing") setSaid({ text: NOTHING_SAID, error: false });
            if (a.review.state === "failed") setSaid({ text: "The review didn't finish. Try again in a moment.", error: true });
            return;
          }
        }
        // Not this page's turn (the tick has it, or it waits to try again): look again shortly.
        if (Date.now() - before < 3_000) await new Promise((r) => setTimeout(r, 5_000));
      }
    })();
    return () => {
      gone = true;
    };
  }, [running, nodeId]);

  if (review === undefined) return null;

  async function run(body: RefreshAction, done?: (a: RefreshAnswer) => string | null) {
    setBusy(true);
    setSaid(null);
    const a = await controls.act(nodeId, body).catch(() => ({ error: "failed" }) as RefreshAnswer);
    setBusy(false);
    if (a.error) {
      setSaid({ text: START_ERRORS[a.error] ?? "That didn't work. Try again in a moment.", error: true });
      return;
    }
    if (a.review !== undefined) setReview(a.review);
    const text = done?.(a);
    if (text) setSaid({ text, error: false });
    onAnswer?.();
  }

  const proposals = review?.state === "ready" ? review.proposals : [];
  const evidence = new Map((review?.evidence ?? []).map((e) => [e.id, e] as const));
  const chosen = proposals.filter((p) => ticked.has(p.id));
  const toggle = (p: ReviewProposal) =>
    setTicked((cur) => {
      const next = new Set(cur);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  const stepAt = review?.step ? ["read", "sources", "research", "brand", "propose"].indexOf(review.step) + 1 : 0;

  return (
    <section id="refresh" aria-labelledby="refresh-h" className="space-y-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="refresh-h" className="text-xs font-semibold">
          Refresh
        </h3>
        {review?.active ? (
          <button type="button" onClick={() => void run({ action: "stop" })} disabled={busy} className="underline disabled:opacity-50">
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run({ action: "start" }, () => null)}
            disabled={disabled || busy}
            className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {busy ? "Starting…" : "Review for refresh"}
          </button>
        )}
      </div>

      {review?.active && review.step ? (
        <p role="status" className="text-neutral-600 dark:text-neutral-300">
          Review running: {stepAt} of 5, {STEP_SAID[review.step]}…
        </p>
      ) : null}
      {!review ? (
        <p className="text-neutral-500 dark:text-neutral-400">
          A review reads the article, its sources, newer research, your brand map and Search Console, and proposes changes. Nothing changes until you apply.
        </p>
      ) : null}

      {proposals.length ? (
        <>
          <p className="text-neutral-600 dark:text-neutral-300">
            Review done · {proposals.length} change{proposals.length === 1 ? "" : "s"} found, none made
          </p>
          <ul className="space-y-2">
            {proposals.map((p) => (
              <li key={p.id} className={`rounded-md border border-neutral-200 p-2 dark:border-neutral-800 ${ticked.has(p.id) ? "" : "opacity-70"}`}>
                <label className="flex gap-2">
                  <input type="checkbox" checked={ticked.has(p.id)} onChange={() => toggle(p)} disabled={busy} className="mt-0.5" />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-mono text-[10.5px] uppercase tracking-wide text-neutral-500">{KIND_SAID[p.kind]}</span>
                    {p.old ? <span className="block text-neutral-500 line-through">{p.old}</span> : null}
                    <span className="block whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">{p.new}</span>
                    {p.evidenceIds.length ? (
                      <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
                        Evidence: {p.evidenceIds.map((id) => evidence.get(id)).filter((e): e is ReviewEvidence => Boolean(e)).map(evidenceLine).join("; ")}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void run({ action: "apply", ids: chosen.map((p) => p.id) }, (a) => APPLIED_SAID(a.applied ?? chosen.length, Boolean(a.real)))}
              disabled={disabled || busy || !chosen.length}
              className="rounded-md bg-neutral-900 px-3 py-1 font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? "Applying…" : `Apply ${chosen.length} change${chosen.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" onClick={() => void run({ action: "dismiss" }, () => DISMISSED_SAID)} disabled={busy} className="underline disabled:opacity-50">
              Dismiss them all
            </button>
          </div>
          {chosen.length ? <p className="text-neutral-500 dark:text-neutral-400">{chosen.some((p) => p.real) ? REAL_UPDATE_SAID : LINKS_ONLY_SAID}</p> : null}
        </>
      ) : null}

      {review?.notes.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-neutral-500 dark:text-neutral-400">
          {review.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {said ? (
        <p role={said.error ? "alert" : "status"} className={said.error ? "text-red-700 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}>
          {said.text}
        </p>
      ) : null}
    </section>
  );
}
