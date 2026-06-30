"use client";

import { useCallback, useEffect, useState } from "react";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import { IngestBar } from "./IngestBar";
import { SourceCard } from "./SourceCard";
import { ChunkBrowser } from "./ChunkBrowser";
import { TestRetrievalPanel } from "./TestRetrievalPanel";

const NON_TERMINAL = ["pending", "running", "embedding"];

/**
 * The Curate pillar ("Idea Vault"): ingest grounding sources, watch them
 * vectorize (live polling), browse chunks, and test retrieval. Workspace-scoped.
 */
export function CuratePanel({
  workspaceId,
  initialSources,
}: {
  workspaceId: string;
  initialSources: IngestionTicket[];
}) {
  const [sources, setSources] = useState<IngestionTicket[]>(initialSources);
  const [browse, setBrowse] = useState<IngestionTicket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/knowledge/sources?ownerKind=workspace&ownerId=${encodeURIComponent(workspaceId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { tickets?: IngestionTicket[] };
      if (Array.isArray(data.tickets)) setSources(data.tickets);
    } catch {
      /* keep current on a transient error */
    }
  }, [workspaceId]);

  // Poll while any source is still ingesting (visibility-aware, bounded).
  const hasActive = sources.some((s) => NON_TERMINAL.includes(s.status));
  useEffect(() => {
    if (!hasActive) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const MAX = 90;
    const INTERVAL = 4000;
    const tick = async () => {
      if (!active) return;
      if (document.visibilityState !== "visible") {
        timer = setTimeout(tick, INTERVAL);
        return;
      }
      polls += 1;
      await refresh();
      if (active && polls < MAX) timer = setTimeout(tick, INTERVAL);
    };
    timer = setTimeout(tick, INTERVAL);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [hasActive, refresh]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Idea Vault</h2>
          <p className="text-xs text-neutral-500">
            Ingest grounding sources (docs, sites, repos). Each is vectorized and tagged so any
            draft in this workspace can ground on it.
          </p>
        </div>
        <IngestBar workspaceId={workspaceId} onIngested={refresh} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Sources ({sources.length})</h2>
        {sources.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
            No sources yet — ingest one above.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {sources.map((s) => (
              <SourceCard
                key={s.id}
                source={s}
                workspaceId={workspaceId}
                onChanged={refresh}
                onBrowse={() => setBrowse(s)}
              />
            ))}
          </div>
        )}
      </section>

      <TestRetrievalPanel workspaceId={workspaceId} />

      {browse ? <ChunkBrowser ticket={browse} onClose={() => setBrowse(null)} /> : null}
    </div>
  );
}
