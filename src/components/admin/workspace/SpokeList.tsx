"use client";

import { useState } from "react";
import type { Template } from "@/lib/types/template";
import { channelLabel, formatLabel } from "@/lib/content/channels";

/** Channel-native spoke variants nested under their hub template. */
export function SpokeList({
  workspaceId,
  spokes,
  onDelete,
}: {
  workspaceId: string;
  spokes: Template[];
  onDelete: (id: string) => void;
}) {
  if (!spokes.length) return null;
  return (
    <div className="ml-3 space-y-2 border-l-2 border-violet-200 pl-3 dark:border-violet-900">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-500">
        Spokes ({spokes.length})
      </div>
      {spokes.map((s) => (
        <SpokeCard key={s.id} workspaceId={workspaceId} spoke={s} onDelete={onDelete} />
      ))}
    </div>
  );
}

function SpokeCard({
  workspaceId,
  spoke,
  onDelete,
}: {
  workspaceId: string;
  spoke: Template;
  onDelete: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!window.confirm("Delete this spoke?")) return;
    setBusy(true);
    const res = await fetch(`/api/admin/workspace/${workspaceId}/templates/${spoke.id}`, {
      method: "DELETE",
    });
    if (res.ok) onDelete(spoke.id);
    else setBusy(false);
  }
  return (
    <div className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-900/60 dark:text-violet-200">
            {channelLabel(spoke.channel ?? "")}
          </span>
          <span className="text-[11px] text-neutral-400">{formatLabel(spoke.format ?? "")}</span>
        </div>
        <button
          onClick={remove}
          disabled={busy}
          className="text-[11px] text-red-600 disabled:opacity-50 dark:text-red-400"
        >
          Delete
        </button>
      </div>
      <div className="text-xs font-medium">{spoke.title}</div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-1.5 text-[11px] dark:bg-neutral-900">
        {spoke.body}
      </pre>
    </div>
  );
}
