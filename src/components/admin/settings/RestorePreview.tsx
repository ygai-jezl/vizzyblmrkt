"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, TriangleAlert } from "lucide-react";
import type { HistoryEntry } from "@/lib/settings/sources";
import type { RestorePreview as Preview } from "@/lib/settings/restorePlan";
import { api } from "../connect/api";
import { Banner, Button } from "../connect/ui";
import { issueText } from "../lifecycle/model";
import { useWords } from "../nav/WordsProvider";
import { Dialog, DialogTable } from "./Dialog";
import { dayText, exportHref, PREVIEW_COPY, restoreErrorText, whenText } from "./historyWords";

/**
 * Preview restore (Settings › History): what comes back, what is archived, what changes back and
 * what a restore never undoes, then the restore itself, from the base the preview showed. A
 * journey's restore fills its draft only, and warns about unpublished edits (with Export the draft)
 * and what to fix against today's catalog. A save in between answers 409: the dialog says so and
 * looks again.
 */
export function RestorePreview({ entry, onClose, onRestored }: { entry: HistoryEntry; onClose: () => void; onRestored: (message: string) => void }) {
  const { ideas } = useWords();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setStale(false);
    setPreview(null);
    const r = await api<{ preview: Preview }>(`/api/admin/settings-history/preview?subject=${encodeURIComponent(entry.subject)}&rev=${entry.rev}`);
    if (!r.ok) return setError(restoreErrorText(r.data));
    setPreview(r.data.preview);
  }, [entry.subject, entry.rev]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore() {
    if (!preview || preview.base === null) return;
    setBusy(true);
    setError(null);
    const r = await api<{ ok?: boolean; rev?: number; error?: string }>("/api/admin/settings-history/restore", {
      method: "POST",
      body: JSON.stringify({ subject: preview.subject, rev: preview.rev, base: preview.base }),
    });
    setBusy(false);
    if (!r.ok) {
      setStale(r.status === 409 && (r.data.error === "fields_changed" || r.data.error === "draft_changed" || r.data.error === "catalog_changed" || r.data.error === "views_changed"));
      return setError(restoreErrorText(r.data));
    }
    if (preview.kind === "journeys") onRestored(PREVIEW_COPY.doneDraft(preview.rev));
    else if (preview.kind === "catalogs") onRestored(PREVIEW_COPY.doneCatalog(r.data.rev ?? (preview.becomes ?? 0)));
    else onRestored(PREVIEW_COPY.done(entry.name, r.data.rev ?? (preview.becomes ?? 0)));
  }

  const journey = entry.kind === "journeys";
  const title = preview?.title ?? (journey ? `Put version ${entry.rev} in the draft?` : `Restore version ${entry.rev}?`);
  const sub = preview
    ? [
        (journey ? PREVIEW_COPY.published : PREVIEW_COPY.saved)(preview.rev, preview.savedBy, dayText(preview.savedAt)),
        preview.becomes !== null && preview.currentRev !== null && !preview.refused ? PREVIEW_COPY.becomes(preview.becomes, preview.currentRev) : null,
      ]
        .filter(Boolean)
        .join(" ")
    : null;

  return (
    <Dialog title={title} sub={sub} busy={busy} onClose={onClose}>
      {!preview ? (
        error ? <Banner tone="err">{error}</Banner> : <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <DialogTable rows={preview.rows} />
          {preview.unpublishedSince ? (
            <p className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {PREVIEW_COPY.unpublished(whenText(preview.unpublishedSince))}{" "}
                <a className="underline underline-offset-2" href={exportHref(preview.subject, "draft")} download>
                  {PREVIEW_COPY.exportDraft}
                </a>
              </span>
            </p>
          ) : null}
          {preview.issues.length ? (
            <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <div>
                <strong>{PREVIEW_COPY.fixAfter}</strong>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {preview.issues.map((i, n) => (
                    <li key={n}>{issueText(i, ideas)}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {preview.refused ? <Banner tone="info">{preview.refused}</Banner> : null}
          {preview.footnote && !preview.refused ? <p className="text-xs text-neutral-500">{preview.footnote}</p> : null}
          {error ? (
            <Banner tone="err">
              {error}{" "}
              {stale ? (
                <button type="button" className="underline underline-offset-2" onClick={() => void load()}>
                  Look again
                </button>
              ) : null}
            </Banner>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={exportHref(preview.subject, preview.rev)}
              download
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              <Download size={14} aria-hidden /> {journey ? PREVIEW_COPY.exportVersion(preview.rev) : PREVIEW_COPY.exportFirst(preview.rev)}
            </a>
            <span className="flex-1" />
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            {!preview.refused && preview.base !== null ? (
              <Button tone="primary" disabled={busy || stale} onClick={() => void restore()}>
                {busy ? "Restoring…" : journey ? PREVIEW_COPY.intoDraft(preview.rev) : PREVIEW_COPY.restoreAs(preview.becomes ?? preview.rev)}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}


