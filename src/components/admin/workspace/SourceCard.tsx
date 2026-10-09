"use client";

import { useState } from "react";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import { contentMatrixLabel } from "@/lib/content/contentMatrix";
import { CITE_TAG, isCiteSource, isCiteSourcesUiEnabled, isWebSource } from "@/lib/knowledge/cite";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  running: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  embedding: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  done: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300",
  partial: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

const SOURCE_LABEL: Record<string, string> = {
  docs_url: "Docs",
  website: "Site",
  github: "GitHub",
  gitlab: "GitLab",
};

function host(uri: string): string {
  try {
    return new URL(uri).host + new URL(uri).pathname;
  } catch {
    return uri;
  }
}

export function SourceCard({
  source,
  workspaceId,
  onChanged,
  onBrowse,
}: {
  source: IngestionTicket;
  workspaceId: string;
  onChanged: () => void | Promise<void>;
  onBrowse: () => void;
}) {
  const [busy, setBusy] = useState<null | "delete" | "reingest" | "cite">(null);
  const [error, setError] = useState<string | null>(null);
  const active = ["pending", "running", "embedding"].includes(source.status);
  const canCite = isCiteSourcesUiEnabled() && isWebSource(source.source);
  const cited = isCiteSource(source.tags);

  /** Mark this source as one an article may cite, or take the mark away. Nothing is read again. */
  async function toggleCite() {
    setBusy("cite");
    setError(null);
    try {
      const res = await fetch(`/api/admin/knowledge/sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cite: !cited }),
      });
      if (!res.ok) {
        setError(res.status === 409 ? "Wait until this source has finished being read." : "Couldn't change that — try again.");
        return;
      }
      await onChanged();
    } catch {
      setError("Couldn't change that — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function reingest() {
    setBusy("reingest");
    setError(null);
    try {
      const body: Record<string, unknown> = {
        ownerKind: "workspace",
        ownerId: workspaceId,
        source: source.source,
        sourceUri: source.sourceUri,
        topic: source.topic,
        tags: source.tags ?? [],
      };
      if (source.ref) body.ref = source.ref;
      if (source.includeGlobs) body.includeGlobs = source.includeGlobs;
      // A source read as one page is read as one page again.
      if (source.onePage !== undefined) body.onePage = source.onePage;
      const res = await fetch("/api/admin/knowledge/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.status === 429 ? "Too many active ingestions." : "Re-ingest failed.");
        return;
      }
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function del() {
    if (!window.confirm("Delete this source and all its chunks?")) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(`/api/admin/knowledge/sources/${source.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Delete failed.");
        return;
      }
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-neutral-300 p-3 text-sm dark:border-neutral-700">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs font-medium text-neutral-500">
            {SOURCE_LABEL[source.source] ?? source.source}
          </span>
          <div className="truncate" title={source.sourceUri}>
            {host(source.sourceUri)}
          </div>
        </div>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[source.status] ?? ""}`}
        >
          {source.status}
          {active ? "…" : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {source.topic ? (
          <span className="rounded bg-violet-50 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
            {contentMatrixLabel(source.topic)}
          </span>
        ) : null}
        {canCite && cited ? (
          <span
            title="Articles can cite this, alongside what a web search finds. On someone else's site it is evidence only — never what you say about yourself."
            className="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
          >
            Cite source
          </span>
        ) : null}
        {canCite && source.onePage ? (
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            One page
          </span>
        ) : null}
        {(source.tags ?? [])
          .filter((t) => !(canCite && t === CITE_TAG))
          .map((t) => (
            <span
              key={t}
              className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              #{t}
            </span>
          ))}
      </div>

      {source.status === "failed" && source.lastError ? (
        <p className="text-xs text-red-600 dark:text-red-400" title={source.lastError}>
          {source.lastError.slice(0, 120)}
        </p>
      ) : (
        <p className="text-xs text-neutral-500">{source.chunksWritten} chunks</p>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        <button
          onClick={onBrowse}
          disabled={source.chunksWritten === 0}
          className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
        >
          View chunks
        </button>
        <button
          onClick={reingest}
          disabled={busy !== null || active}
          className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
        >
          {busy === "reingest" ? "…" : "Re-ingest"}
        </button>
        {canCite ? (
          <button
            onClick={toggleCite}
            disabled={busy !== null || active || source.chunksWritten === 0}
            title={
              cited
                ? "Stop articles citing this source. It goes back to being ordinary knowledge."
                : "Let articles cite this source, alongside what a web search finds."
            }
            className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
          >
            {busy === "cite" ? "…" : cited ? "Stop citing" : "Cite in articles"}
          </button>
        ) : null}
        <button
          onClick={del}
          disabled={busy !== null}
          className="rounded border border-red-300 px-2 py-1 text-red-700 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
        >
          {busy === "delete" ? "…" : "Delete"}
        </button>
      </div>
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
