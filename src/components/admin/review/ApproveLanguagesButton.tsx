"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/components/admin/connect/api";

/**
 * Review: approve every translation of one journey waiting to be checked (ASSET_TRANSLATIONS_ENABLED),
 * each at the rev the row showed. One that changed since is left to check in the journey.
 */
export function ApproveLanguagesButton({ journeyId, revs }: { journeyId: string; revs: Record<string, number> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          const r = await api<{ approved?: number; skipped?: number }>(`/api/admin/lifecycle/journeys/${journeyId}/translations`, {
            method: "POST",
            body: JSON.stringify({ action: "approve_all", revs }),
          });
          setBusy(false);
          if (!r.ok) return setNote(errorText(r.data));
          if (r.data.skipped) setNote(`${r.data.skipped} changed since. Open the journey to check them.`);
          router.refresh();
        }}
        className="rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50"
      >
        {busy ? "Approving…" : "Approve all languages"}
      </button>
      {note ? <span className="text-xs text-shell-muted">{note}</span> : null}
    </span>
  );
}
