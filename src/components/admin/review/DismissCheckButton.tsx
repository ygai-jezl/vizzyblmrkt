"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/components/admin/connect/api";
import { strategyErrorText } from "@/components/admin/brand-kit/strategyMessages";

/** Review: dismiss the weekly strategy check's row for 30 days, then show the list without it. */
export function DismissCheckButton() {
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
          const r = await api("/api/admin/brand-kit/map/strategy/check", { method: "POST", body: "{}" });
          setBusy(false);
          if (!r.ok) return setError(strategyErrorText(r.data));
          router.refresh();
        }}
        className="rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50"
      >
        {busy ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
