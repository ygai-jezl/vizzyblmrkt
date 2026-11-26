"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, History as HistoryIcon } from "lucide-react";
import type { HistoryEntry, HistoryKind, HistoryPage } from "@/lib/settings/sources";
import type { RecordFieldObject } from "@/lib/types/recordField";
import { loadFieldLists, type StoredFieldList } from "../audience/fieldsApi";
import { api } from "../connect/api";
import { Badge, Banner, Button } from "../connect/ui";
import { EraseDialog } from "./EraseDialog";
import { entryKey, historyEraseTargets, type EraseTarget } from "./eraseNotes";
import { dayText, ERASE_COPY, exportHref, HISTORY_COPY, whenText } from "./historyWords";
import { RestorePreview } from "./RestorePreview";

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to the brand's fields, journeys,
 * product catalogs, shared connections and team views (CRM_VIEWS_ENABLED), newest first, filtered by kind. Anyone on the team
 * reads it and exports a version; admins preview a restore and make it, and an owner who can
 * erase (SETTINGS_ERASE_ENABLED) sees Erase values on the entry that archived a field whose values
 * can be erased now. Who did it is a name looked up on the server (a team member's sign in address
 * when they have no name set), never an address kept on an old record.
 */

const pill = (on: boolean) =>
  `rounded-md border px-2.5 py-1 text-xs ${
    on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

/**
 * What changed, as one line: the saver's own words when there are some ("Gave ‘Google Analytics,
 * fernhill.example’", "Erased the values of ‘Old loyalty tier’"), else each item; a restore says
 * which version, then each item.
 */
export function summaryOf(e: Pick<HistoryEntry, "items" | "message" | "restoredFrom" | "kind">): string {
  const restore = !!e.restoredFrom && e.kind !== "journeys";
  const parts = restore ? [e.message ?? `Restored version ${e.restoredFrom}`, ...e.items] : e.message ? [e.message] : e.items;
  const text = parts.filter(Boolean).map((p) => p.replace(/\.$/, "")).join(". ");
  return text ? `${text}.` : "";
}

export function HistoryView({ canRestore, lead, eraseOwner = false }: { canRestore: boolean; lead: string; eraseOwner?: boolean }) {
  const [kind, setKind] = useState<HistoryKind | null>(null);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<HistoryEntry | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [lists, setLists] = useState<Record<RecordFieldObject, StoredFieldList> | null>(null);
  const [erasing, setErasing] = useState<EraseTarget | null>(null);
  // Each list load is numbered: an answer that arrives after a newer load started (a quick switch of
  // filter, a reload after a restore) is dropped, so one kind's list never shows under another's.
  const loads = useRef(0);

  const load = useCallback(async () => {
    const mine = ++loads.current;
    setFailed(false);
    const r = await api<HistoryPage>(`/api/admin/settings-history${kind ? `?kind=${kind}` : ""}`);
    if (mine !== loads.current) return;
    if (!r.ok) return setFailed(true);
    setPage(r.data);
  }, [kind]);

  useEffect(() => {
    setPage(null);
    void load();
  }, [load]);

  // An owner who can erase: the fields as they are now, to offer Erase values on the entry that archived one.
  const loadLists = useCallback(() => {
    if (!eraseOwner) return;
    void loadFieldLists().then((r) => setLists(r.ok ? r.data.lists : null));
  }, [eraseOwner]);
  useEffect(() => loadLists(), [loadLists]);
  const eraseTargets = useMemo(() => (page && lists ? historyEraseTargets(page.entries, lists) : new Map<string, EraseTarget[]>()), [page, lists]);

  async function older() {
    if (!page?.next || loadingMore) return;
    const mine = loads.current;
    setLoadingMore(true);
    const r = await api<HistoryPage>(`/api/admin/settings-history?${kind ? `kind=${kind}&` : ""}cursor=${encodeURIComponent(page.next)}`);
    setLoadingMore(false);
    // The list changed meanwhile (another filter, a reload): this page belongs to the old one.
    if (mine !== loads.current) return;
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
            <li key={entryKey(e)} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>
                    {e.name}, version {e.rev}
                  </span>
                  {e.live ? <Badge tone="green">{HISTORY_COPY.live}</Badge> : null}
                  {e.readOnly === "shared" ? <Badge>{HISTORY_COPY.readOnly}</Badge> : null}
                  {e.readOnly === "archived_journey" ? <Badge>{HISTORY_COPY.archivedJourney}</Badge> : null}
                  {e.readOnly === "revoked_connection" ? <Badge>{HISTORY_COPY.revokedProduct}</Badge> : null}
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
                {(eraseTargets.get(entryKey(e)) ?? []).map((t, _i, all) => (
                  <button
                    key={t.fieldId}
                    type="button"
                    className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-neutral-950 dark:text-red-400 dark:hover:bg-red-950/40"
                    onClick={() => setErasing(t)}
                  >
                    {all.length > 1 ? ERASE_COPY.actionOf(t.label) : ERASE_COPY.action}
                  </button>
                ))}
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
      {erasing ? (
        <EraseDialog
          object={erasing.object}
          fieldId={erasing.fieldId}
          onClose={() => setErasing(null)}
          onChanged={() => {
            loadLists();
            void load();
          }}
        />
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
