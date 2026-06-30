"use client";

import { useEffect, useState } from "react";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";

interface ChunkView {
  id: string;
  title: string;
  path: string | null;
  heading: string | null;
  content: string;
  tokenCount: number;
  chunkIndex: number;
}

/** Modal listing the chunks a source produced. */
export function ChunkBrowser({
  ticket,
  onClose,
}: {
  ticket: IngestionTicket;
  onClose: () => void;
}) {
  const [chunks, setChunks] = useState<ChunkView[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/knowledge/chunks?ticketId=${encodeURIComponent(ticket.id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (active) setChunks(Array.isArray(d.chunks) ? (d.chunks as ChunkView[]) : []);
      })
      .catch(() => {
        if (active) setChunks([]);
      });
    return () => {
      active = false;
    };
  }, [ticket.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold" title={ticket.sourceUri}>
            Chunks · {ticket.sourceUri}
          </h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">
            ×
          </button>
        </div>
        {chunks === null ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : chunks.length === 0 ? (
          <p className="text-sm text-neutral-500">No chunks for this source.</p>
        ) : (
          <ul className="space-y-3">
            {chunks.map((c) => (
              <li
                key={c.id}
                className="rounded border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <div className="text-xs text-neutral-500">
                  {c.path ?? c.heading ?? c.title} · {c.tokenCount} tok
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-700 dark:text-neutral-300">
                  {c.content.slice(0, 800)}
                  {c.content.length > 800 ? "…" : ""}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
