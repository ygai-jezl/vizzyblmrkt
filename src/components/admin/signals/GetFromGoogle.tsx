"use client";

import { useEffect, useRef, useState } from "react";
import { mergeIntoBox, type SignalView } from "@/lib/signals/view";

/**
 * "Get from Google" beside What buyers ask, in the Create wizard and the blog brief
 * (SIGNALS_DATAFORSEO_ENABLED, and the brand's next_up feature). Looks the article's question up on
 * Google through DataForSEO; the judge (src/lib/signals/judge.ts) keeps what fits this article, and
 * only that is added: People also ask and what else people search for. What it left out is listed
 * with why. It only ever adds lines; what someone typed stays. Hidden when the brand can't use it.
 */

const BUTTON =
  "rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const HINT = "text-[11px] text-neutral-500 dark:text-neutral-400";

/** Checked every 10 seconds, for up to 6 minutes. */
const POLL_MS = 10_000;
const POLL_FOR_MS = 6 * 60_000;

interface Status {
  available: boolean;
  market: string;
  used: number;
  limit: number;
}

const ERRORS = {
  monthly_limit: "This brand has used all its Google lookups for this month.",
  rate_limited: "Too many lookups at once. Try again in a minute.",
  not_set_up: "Google lookups aren't set up on this copy of YouGrow yet.",
  lookup_failed: "Google couldn't be asked just now. Try again in a few minutes.",
  invalid_input: "Write the question this article answers first.",
} as const;
const errorFor = (code: string | undefined): string => (code && code in ERRORS ? ERRORS[code as keyof typeof ERRORS] : ERRORS.lookup_failed);

export function GetFromGoogle({
  query,
  questionId,
  subjectId,
  current,
  onAdd,
  disabled,
}: {
  query: string;
  questionId: string | null;
  subjectId: string | null;
  current: string;
  onAdd: (text: string) => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [state, setState] = useState<"idle" | "asking" | "waiting">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<SignalView["leftOut"]>([]);
  // A lookup can take minutes: by then the box (and the brief) may have changed, so read the latest.
  const currentRef = useRef(current);
  currentRef.current = current;
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    void fetch("/api/admin/signals/serp")
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => {
        if (!stopped.current) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      stopped.current = true;
    };
  }, []);

  if (!status) return null;

  const fill = (signal: SignalView) => {
    if (!signal.judged) {
      setMessage("Google's results couldn't be checked for this article just now. Try again in a minute; it won't count twice.");
      return;
    }
    const { text, added } = mergeIntoBox(currentRef.current, signal.lines);
    if (added) onAddRef.current(text);
    setLeftOut(signal.leftOut);
    const out = signal.leftOut.length ? ` Left out ${signal.leftOut.length} that didn't fit.` : "";
    setMessage(
      added
        ? `Added ${added} line${added === 1 ? "" : "s"} from ${signal.market}.${out}`
        : signal.lines.length
          ? `Everything that fits is already in the box.${out}`
          : `Nothing Google showed fits this article.${out} Try wording the question the way a buyer would ask it.`,
    );
  };

  const wait = async (id: string) => {
    const until = Date.now() + POLL_FOR_MS;
    setState("waiting");
    while (!stopped.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await fetch(`/api/admin/signals/serp/${id}`).catch(() => null);
      if (!res?.ok) continue;
      const { signal } = (await res.json()) as { signal: SignalView };
      if (signal.status === "ready") return fill(signal);
      if (signal.status === "failed") return setMessage(ERRORS.lookup_failed);
    }
    if (!stopped.current) setMessage("Google is taking longer than usual. Try again in a few minutes; it won't count twice.");
  };

  const ask = async () => {
    setMessage(null);
    setLeftOut([]);
    setState("asking");
    try {
      const res = await fetch("/api/admin/signals/serp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, questionId, subjectId }),
      }).catch(() => null);
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; signal?: SignalView; reused?: boolean }) : {};
      if (!res?.ok || !body.signal) {
        setMessage(errorFor(body.error));
        return;
      }
      // A question looked up lately is used again without counting.
      if (!body.reused) setStatus((s) => (s ? { ...s, used: s.used + 1 } : s));
      if (body.signal.status === "ready") fill(body.signal);
      else if (body.signal.status === "failed") setMessage(ERRORS.lookup_failed);
      else await wait(body.signal.id);
    } finally {
      if (!stopped.current) setState("idle");
    }
  };

  if (!status.available) return <p className={`mt-1 ${HINT}`}>{ERRORS.not_set_up}</p>;
  const busy = state !== "idle";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <button type="button" onClick={() => void ask()} disabled={disabled || busy || query.trim().length < 3} className={BUTTON}>
        {state === "asking" ? "Asking Google…" : state === "waiting" ? "Waiting for Google…" : "Get from Google"}
      </button>
      <span className={HINT} aria-live="polite">
        {message ?? `Adds the questions from ${status.market} that fit this article. ${status.used} of ${status.limit} lookups used this month.`}
      </span>
      {leftOut.length ? (
        <details className={`w-full ${HINT}`}>
          <summary className="cursor-pointer">What was left out, and why</summary>
          <ul className="mt-1 space-y-0.5">
            {leftOut.map((i) => (
              <li key={i.text}>
                &ldquo;{i.text}&rdquo;: {i.verdict === "other" ? "for another article" : "left out"}
                {i.reason ? `, ${i.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
