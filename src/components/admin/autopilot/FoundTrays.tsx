"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { NextUpPick, TrayItem, Trays } from "@/lib/types/autopilot";

/**
 * Find what buyers ask for one of Next up's picks (BRAND_MAP_NEXT_UP_ENABLED): Google's People also
 * ask and "people also search for", and the questions competitors' articles answer, sorted by the
 * judge into three trays. Moving an item teaches the judge (the Learned list); "Write it" opens the
 * Create wizard with the first tray as What buyers ask.
 */

export interface RunView {
  id: string;
  step: string;
  trays: Trays | null;
  googleSkipped: string | null;
  error: string | null;
}

const HINT = "text-xs text-neutral-500 dark:text-neutral-400";
const SMALL = "rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const BUTTON = "rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const POLL_MS = 8_000;

const TRAYS: Array<{ key: keyof Trays; title: string; box: string }> = [
  { key: "use", title: "In this article", box: "border-blue-400 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30" },
  { key: "other", title: "Another subject", box: "border-blue-300 dark:border-blue-700" },
  { key: "drop", title: "Not for us", box: "border-dashed border-neutral-300 dark:border-neutral-700" },
];
const KIND: Record<TrayItem["kind"], string> = { paa: "People also ask", also: "Also searched", theirs: "Their articles" };
const STEP: Record<string, string> = {
  find: "Asking Google…",
  waiting: "Waiting for Google, usually under a minute…",
  sort: "Sorting what was found…",
};
const SKIPPED: Record<string, string> = {
  monthly_limit: "Google wasn't asked: this brand has used its lookups for the month.",
  not_set_up: "Google wasn't asked: lookups aren't set up on this copy of YouGrow.",
  not_included: "Google wasn't asked: lookups aren't part of this brand's plan.",
};

function WriteLink({ pick, runId, programmes }: { pick: NextUpPick; runId: string; programmes: Array<{ id: string; name: string }> }) {
  const href = (ws: string) => `/admin/workspace/${encodeURIComponent(ws)}/create?question=${encodeURIComponent(pick.questionId)}&run=${encodeURIComponent(runId)}`;
  if (programmes.length === 1) {
    return (
      <Link href={href(programmes[0]!.id)} className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
        Write it
      </Link>
    );
  }
  return (
    <details className="relative">
      <summary className="cursor-pointer rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">Write it</summary>
      <div className="absolute z-10 mt-1 w-56 rounded-md border border-neutral-200 bg-white p-1 shadow dark:border-neutral-800 dark:bg-neutral-950">
        <p className={`px-2 py-1 ${HINT}`}>In which programme?</p>
        {programmes.map((p) => (
          <Link key={p.id} href={href(p.id)} className="block rounded px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {p.name}
          </Link>
        ))}
      </div>
    </details>
  );
}

export function FoundTrays({
  pick,
  isAdmin,
  programmes,
  initialRun = null,
}: {
  pick: NextUpPick;
  isAdmin: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  /** A run already sorted (by autopilot, in Suggest mode). */
  initialRun?: RunView | null;
}) {
  const [run, setRun] = useState<RunView | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const stopped = useRef(false);
  useEffect(() => () => void (stopped.current = true), []);

  const poll = async (id: string) => {
    for (let i = 0; i < 60 && !stopped.current; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await fetch(`/api/admin/brand-kit/autopilot/runs/${id}`).catch(() => null);
      if (!res?.ok) continue;
      const next = ((await res.json()) as { run: RunView }).run;
      setRun(next);
      if (next.step === "sorted" || next.step === "failed" || next.step === "stopped") return;
    }
  };

  const start = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/brand-kit/autopilot/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: pick.questionId, question: pick.question, subjectId: pick.subjectId, subjectName: pick.subjectName }),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { run?: RunView; error?: string }) : {};
    if (!res?.ok || !body.run) {
      setBusy(false);
      setMessage(body.error === "rate_limited" ? "A lot was looked up just now. Try again in a few minutes." : "That didn't start. Try again in a minute.");
      return;
    }
    setRun(body.run);
    if (!["sorted", "failed", "stopped"].includes(body.run.step)) await poll(body.run.id);
    setBusy(false);
  };

  const move = async (item: TrayItem, to: keyof Trays) => {
    if (!run) return;
    const res = await fetch(`/api/admin/brand-kit/autopilot/runs/${run.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: item.text, to }),
    }).catch(() => null);
    if (res?.ok) setRun(((await res.json()) as { run: RunView }).run);
  };

  const suggest = async () => {
    if (!run?.trays) return;
    const texts = run.trays.other.filter((i) => i.subject).map((i) => i.text).slice(0, 10);
    const res = await fetch(`/api/admin/brand-kit/autopilot/runs/${run.id}/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { filed: number }) : null;
    setFiled(body ? (body.filed ? `${body.filed} suggested: they wait on your brand map.` : "Already on your brand map, or waiting there.") : "That didn't go through. Try again.");
  };

  if (!run) {
    return (
      <>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void start()}>
          {busy ? "Starting…" : "Find what they ask"}
        </button>
        {message ? <span className={HINT}>{message}</span> : null}
      </>
    );
  }
  if (!run.trays) {
    return <span className={HINT} aria-live="polite">{run.step === "failed" ? "Sorting didn't finish. Try again in a few minutes." : (STEP[run.step] ?? "Working…")}</span>;
  }
  return (
    <div className="w-full space-y-2">
      {run.googleSkipped ? <p className={HINT}>{SKIPPED[run.googleSkipped] ?? "Google didn't answer this time, so only competitors' questions were sorted."}</p> : null}
      <div className="grid gap-2 md:grid-cols-3">
        {TRAYS.map((t) => (
          <div key={t.key} className={`space-y-1.5 rounded-md border p-2 ${t.box}`}>
            <h4 className="flex justify-between text-xs font-semibold">
              {t.title} <span className={HINT}>{run.trays![t.key].length}</span>
            </h4>
            {run.trays![t.key].map((item) => (
              <div key={item.text} className="space-y-1 rounded border border-neutral-200 bg-white p-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-950">
                <span className="block text-[10px] uppercase tracking-wide text-neutral-500">{KIND[item.kind]}</span>
                <span className="block">{item.text}</span>
                {t.key === "other" && item.subject ? <span className="block text-[11px] text-blue-700 dark:text-blue-300">Fits: {item.subject}</span> : null}
                {item.reason ? <span className={`block ${HINT}`}>{item.reason}</span> : null}
                <span className="flex flex-wrap gap-1">
                  {item.you ? <span className="rounded-full border border-blue-400 px-1.5 text-[10px]">Yours: {item.you}</span> : null}
                  {item.them ? <span className="rounded-full border border-dashed border-neutral-400 px-1.5 text-[10px]">{item.them} answers it</span> : null}
                </span>
                <span className="flex flex-wrap gap-1">
                  {TRAYS.filter((x) => x.key !== t.key).map((x) => (
                    <button key={x.key} type="button" className={SMALL} onClick={() => void move(item, x.key)}>
                      To {x.title.toLowerCase()}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {programmes?.length ? <WriteLink pick={pick} runId={run.id} programmes={programmes} /> : null}
        {isAdmin && run.trays.other.some((i) => i.subject) ? (
          <button type="button" className={BUTTON} onClick={() => void suggest()}>
            Suggest &ldquo;Another subject&rdquo; for the brand map
          </button>
        ) : null}
        {filed ? <span className={HINT}>{filed}</span> : null}
      </div>
    </div>
  );
}
