"use client";

import { useCallback, useEffect, useState } from "react";
import { KIND_GROUPS } from "@/lib/search/labels";
import type { SearchKind } from "@/lib/search/types";

interface Summary {
  records: number;
  chunks: number;
  waitingForMeaning: number;
  byKind: Partial<Record<SearchKind, number>>;
  lastIndexedAt: string | null;
  database: string;
  location: string;
  model: string;
  reranked: boolean;
}

function ago(iso: string | null): string {
  if (!iso) return "Not yet";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Settings › Search (NEXT_PUBLIC_SEARCH_ENABLED): what the brand's search index holds, where it
 * lives, and a rebuild for admins. The help page /help/search explains each line.
 */
export function SearchSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/search/index").catch(() => null);
    if (res?.ok) {
      setSummary((await res.json()) as Summary);
      return;
    }
    setMessage(res?.status === 403 ? "Search isn't available for this brand yet." : "Search didn't answer. Try again in a moment.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/search/index", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setMessage(res?.status === 403 ? "Only admins can rebuild the search index." : "Search didn't answer. Try again in a moment.");
      return;
    }
    const out = (await res.json()) as { indexed: number; removed: number; partial: boolean; summary: Summary };
    setSummary(out.summary);
    setMessage(out.partial ? "Part done. The next check carries on with the rest." : `Up to date. ${out.indexed} added or changed, ${out.removed} removed.`);
  };

  const rows: Array<[string, string]> = summary
    ? [
        ["Region", `${summary.location} (database ${summary.database})`],
        ["Model", summary.model],
        ["Reranking", summary.reranked ? "On" : "Off. Google reranks only for US brands, when it's turned on."],
        ["Last update", ago(summary.lastIndexedAt)],
      ]
    : [];

  return (
    <section className="max-w-2xl space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Search</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">Ctrl K or ⌘K, then type</span>
      </div>
      <div className="rounded-md border border-neutral-200 text-sm dark:border-neutral-800">
        {summary ? (
          <>
            <dl className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {rows.map(([k, v]) => (
                <div key={k} className="flex gap-4 px-4 py-2.5">
                  <dt className="w-36 shrink-0 text-neutral-500 dark:text-neutral-400">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-neutral-100 px-4 py-3 sm:grid-cols-3 dark:border-neutral-900">
              {KIND_GROUPS.map((g) => (
                <div key={g.key} className="flex justify-between gap-2">
                  <span className="text-neutral-500 dark:text-neutral-400">{g.label}</span>
                  <span className="tabular-nums">{g.kinds.reduce((n, k) => n + (summary.byKind[k] ?? 0), 0)}</span>
                </div>
              ))}
            </div>
            {summary.records === 0 ? (
              <p className="border-t border-neutral-100 px-4 py-2.5 text-neutral-500 dark:border-neutral-900">
                Nothing in the index yet. The first check fills it within about 10 minutes.
              </p>
            ) : null}
            {summary.waitingForMeaning > 0 ? (
              <p className="border-t border-neutral-100 px-4 py-2.5 text-neutral-500 dark:border-neutral-900">
                {summary.waitingForMeaning} found by words only until their meaning is added.
              </p>
            ) : null}
          </>
        ) : (
          <p className="px-4 py-3 text-neutral-500">{message ?? "Loading…"}</p>
        )}
        {summary && isAdmin ? (
          <div className="flex items-center gap-3 border-t border-neutral-100 px-4 py-3 dark:border-neutral-900">
            <button
              type="button"
              onClick={rebuild}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              {busy ? "Rebuilding…" : "Rebuild index"}
            </button>
            {message ? <span className="text-neutral-500 dark:text-neutral-400">{message}</span> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
