"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, History as HistoryIcon } from "lucide-react";
import type { HistoryEntry, HistoryKind, HistoryPage } from "@/lib/settings/sources";
import { api } from "../connect/api";
import { Badge, Banner, Button } from "../connect/ui";
import { dayText, exportHref, HISTORY_COPY, whenText } from "./historyWords";
import { RestorePreview } from "./RestorePreview";

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to the brand's fields, journeys,
 * product catalogs and shared connections, newest first, filtered by kind. Anyone on the team
 * reads it and exports a version; admins preview a restore and make it. Who did it is a name
 * looked up on the server, never an address.
 */

const pill = (on: boolean) =>
  `rounded-md border px-2.5 py-1 text-xs ${
    on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

/** What changed, as one line: a restore says which version, then each item. */
export function summaryOf(e: Pick<HistoryEntry, "items" | "message" | "restoredFrom" | "kind">): string {
  const parts = e.items.length ? (e.restoredFrom && e.kind !== "journeys" ? [e.message ?? `Restored version ${e.restoredFrom}`, ...e.items] : e.items) : [e.message ?? ""];
  const text = parts.filter(Boolean).map((p) => p.replace(/\.$/, "")).join(". ");
  return text ? `${text}.` : "";
}

export function HistoryView({ canRestore, lead }: { canRestore: boolean; lead: string }) {
  const [kind, setKind] = useState<HistoryKind | null>(null);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<HistoryEntry | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    const r = await api<HistoryPage>(`/api/admin/settings-history${kind ? `?kind=${kind}` : ""}`);
    if (!r.ok) return setFailed(true);
    setPage(r.data);
  }, [kind]);

  useEffect(() => {
    setPage(null);
    void load();
  }, [load]);

  async function older() {
    if (!page?.next || loadingMore) return;
    setLoadingMore(true);
    const r = await api<HistoryPage>(`/api/admin/settings-history?${kind ? `kind=${kind}&` : ""}cursor=${encodeURIComponent(page.next)}`);
    setLoadingMore(false);
    // A page that didn't load leaves the list as it is; the button stays to try again.
    if (!r.ok) return;
    setPage((cur) => (cur ? { ...r.data, entries: [...cur.entries, ...r.data.entries] } : r.data));
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">History</h2>
        <p className="text-sm text-neutral-500">{lead}</p>
      </div>
      {page && page.kinds.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          <button type="button" aria-pressed={kind === null} className={pill(kind === null)} onClick={() => setKind(null)}>
            All
          </button>
          {page.kinds.map((k) => (
            <button key={k.kind} type="button" aria-pressed={kind === k.kind} className={pill(kind === k.kind)} onClick={() => setKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
      ) : null}
      {done ? <Banner tone="ok">{done}</Banner> : null}
      {failed ? <Banner tone="err">{HISTORY_COPY.loadFailed}</Banner> : null}
      {page?.partial ? <Banner tone="info">{HISTORY_COPY.partial}</Banner> : null}
      {!page ? (
        failed ? null : <p className="text-sm text-neutral-500">Loading…</p>
      ) : page.entries.length === 0 ? (
        <p className="text-sm text-neutral-500">{HISTORY_COPY.empty}</p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
          {page.entries.map((e) => (
            <li key={`${e.subject}:${e.rev}`} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>
                    {e.name}, version {e.rev}
                  </span>
                  {e.live ? <Badge tone="green">{HISTORY_COPY.live}</Badge> : null}
                  {e.readOnly === "shared" ? <Badge>{HISTORY_COPY.readOnly}</Badge> : null}
                </div>
                <div className="text-xs text-neutral-500" title={dayText(e.at)}>
                  {e.by} · {whenText(e.at)}
                </div>
                <div className="text-neutral-700 dark:text-neutral-300">{summaryOf(e)}</div>
                {e.draft ? (
                  <p className="mt-1 inline-block rounded-md bg-sky-50 px-2 py-1 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                    {HISTORY_COPY.draftNote(e.draft.version, e.draft.by, whenText(e.draft.at))}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {canRestore && e.canRestore ? (
                  <Button onClick={() => setOpen(e)}>
                    <HistoryIcon size={14} aria-hidden /> Preview restore
                  </Button>
                ) : null}
                {e.canExport ? (
                  <a
                    href={exportHref(e.subject, e.rev)}
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
                  >
                    <Download size={14} aria-hidden /> Export
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {page?.next ? (
        <Button disabled={loadingMore} onClick={() => void older()}>
          {loadingMore ? "Loading…" : HISTORY_COPY.older}
        </Button>
      ) : null}
      {open ? (
        <RestorePreview
          entry={open}
          onClose={() => setOpen(null)}
          onRestored={(message) => {
            setOpen(null);
            setDone(message);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
