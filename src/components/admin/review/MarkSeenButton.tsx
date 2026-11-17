"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/components/admin/connect/api";

/** Review: mark one competitor's changes seen, then show the list without them. */
export function MarkSeenButton({ competitorId }: { competitorId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const r = await api("/api/admin/brand-kit/competitors/seen", { method: "POST", body: JSON.stringify({ competitorId }) });
          setBusy(false);
          if (!r.ok) return setError(errorText(r.data));
          router.refresh();
        }}
        className="rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50"
      >
        {busy ? "Marking…" : "Mark seen"}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
