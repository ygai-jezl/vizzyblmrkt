"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * On a workflow the article autopilot is writing (CREATE_ARTICLE_AUTOPILOT_ENABLED): says so, and
 * lets a person take over, which stops the run and lets edits save again.
 */
export function AutopilotBanner({ workspaceId, planId }: { workspaceId: string; planId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm dark:border-blue-700 dark:bg-blue-950/40" role="status">
      <span>
        Autopilot is writing this workflow. Edits won&apos;t save until it finishes, or until you take over.
        {error ? <span className="block text-xs text-red-600 dark:text-red-400">That didn&apos;t go through. Try again.</span> : null}
      </span>
      <button
        type="button"
        disabled={busy}
        className="rounded-md border border-blue-400 bg-white px-2.5 py-1 text-xs font-medium hover:bg-blue-100 disabled:opacity-50 dark:border-blue-600 dark:bg-neutral-900 dark:hover:bg-blue-900/40"
        onClick={async () => {
          setBusy(true);
          setError(false);
          const res = await fetch(`/api/admin/workspace/${encodeURIComponent(workspaceId)}/content-plans/${encodeURIComponent(planId)}/autopilot/take-over`, { method: "POST" }).catch(() => null);
          setBusy(false);
          if (res?.ok) router.refresh();
          else setError(true);
        }}
      >
        {busy ? "Taking over…" : "Take over"}
      </button>
    </div>
  );
}
