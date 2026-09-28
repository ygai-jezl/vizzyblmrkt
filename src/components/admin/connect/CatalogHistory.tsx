"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, errorText, timeAgo } from "./api";
import { Badge, Banner, Button, Section } from "./ui";

type Version = {
  rev: number;
  savedAt: string;
  savedBy: string | null;
  source: "editor" | "learn" | "restore" | "before_history";
  restoredFrom: number | null;
  changes: string[];
};

const SHOWN = 3;

function sourceOf(v: Version): string {
  if (v.source === "learn") return "Learn from repo";
  if (v.source === "restore") return `Restored version ${v.restoredFrom ?? "?"}`;
  if (v.source === "before_history") return "As it was before history was kept";
  return "Catalog tab";
}

/**
 * The catalog's last saved versions — what changed, who saved it, when — with
 * Restore. A restore is saved as a new version, so the one it replaces stays here.
 */
export function CatalogHistory({
  connectionId,
  currentRev,
  canEdit,
  dirty,
  onRestore,
}: {
  connectionId: string;
  /** The version on screen: refetched when it changes. */
  currentRev: number;
  canEdit: boolean;
  /** There are unsaved edits (a restore discards them). */
  dirty: boolean;
  onRestore: (rev: number) => Promise<void>;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ versions: Version[] }>(`/api/admin/connections/${connectionId}/catalog-history`);
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setVersions(r.data.versions);
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load, currentRev]);

  async function restore(v: Version) {
    const ask = `Restore version ${v.rev}? It's saved as a new version, so the current one stays in the history.${dirty ? " Your unsaved edits will be discarded." : ""}`;
    if (!window.confirm(ask)) return;
    setBusy(v.rev);
    await onRestore(v.rev);
    setBusy(null);
    await load();
  }

  return (
    <Section title="History" description="The last 20 saved versions of this catalog. Restoring one saves it as a new version, so nothing is lost.">
      {error ? <Banner tone="err">{error}</Banner> : null}
      {versions === null ? (
        error ? null : <p className="text-sm text-neutral-500">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="text-sm text-neutral-500">No saved versions yet. The next save starts the history.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {versions.map((v) => (
            <li key={v.rev} className="flex flex-wrap items-start gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">Version {v.rev}</span>
                  {v.rev === currentRev ? <Badge tone="green">current</Badge> : null}
                  <span className="text-xs text-neutral-500" title={new Date(v.savedAt).toLocaleString()}>
                    {sourceOf(v)} · {timeAgo(v.savedAt)}
                    {v.savedBy ? ` · ${v.savedBy}` : ""}
                  </span>
                </div>
                {v.changes.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                    {(open === v.rev ? v.changes : v.changes.slice(0, SHOWN)).map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null}
                {v.changes.length > SHOWN ? (
                  <button type="button" className="text-xs text-neutral-500 underline" onClick={() => setOpen(open === v.rev ? null : v.rev)}>
                    {open === v.rev ? "Show less" : `${v.changes.length - SHOWN} more`}
                  </button>
                ) : null}
              </div>
              {canEdit && v.rev !== currentRev ? (
                <Button disabled={busy !== null} onClick={() => void restore(v)}>
                  <RotateCcw size={14} /> {busy === v.rev ? "Restoring…" : "Restore"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
