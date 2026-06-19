"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Archive (close) or restore a launch — the reversible, non-destructive
 * counterpart to the delete danger zone. Archiving stops public signups, pauses
 * the active journey, and moves the launch out of "Active Launches" while keeping
 * every record (so the data stays available to agents/analytics). No typed
 * confirmation (unlike delete — it's reversible); an optional reason is recorded
 * on the audit trail. Rendered only for admins; the route enforces the role too.
 */
export function ArchiveLaunchSection({
  campaignId,
  campaignName,
  archived,
}: {
  campaignId: string;
  campaignName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const action = archived ? "restore" : "archive";
  const busy = status === "working";

  async function onSubmit() {
    if (busy) return;
    setStatus("working");
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data.error === "forbidden"
            ? "Only an admin can archive a launch."
            : data.error === "campaign_not_found"
              ? "This launch no longer exists."
              : `${archived ? "Restore" : "Archive"} failed — please try again.`,
        );
        setStatus("error");
        return;
      }
      // State changed — refresh so the sidebar + banner reflect it.
      router.refresh();
      setStatus("idle");
    } catch {
      setError("Network error — please try again.");
      setStatus("error");
    }
  }

  return (
    <section className="mt-8 space-y-4 rounded-md border border-amber-300 bg-amber-50/40 p-5 dark:border-amber-900/70 dark:bg-amber-950/20">
      {archived ? (
        <div>
          <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Restore this launch
          </h2>
          <p className="mt-1 text-sm text-amber-700/90 dark:text-amber-300/80">
            <span className="font-medium">{campaignName}</span> is archived — its
            public waitlist is closed to new signups. Restoring reopens signups
            immediately. Note: paused email journeys are{" "}
            <span className="font-medium">not</span> resumed automatically —
            re-activate them from the Journey page.
          </p>
        </div>
      ) : (
        <div>
          <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Archive this launch
          </h2>
          <p className="mt-1 text-sm text-amber-700/90 dark:text-amber-300/80">
            Closes <span className="font-medium">{campaignName}</span>: the public
            waitlist stops accepting new signups, any active email journey is
            paused, and the launch moves out of Active Launches. All data is kept
            and stays available to your agents. You can restore it at any time.
          </p>
        </div>
      )}

      {!archived ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium text-amber-800 dark:text-amber-300">
            Reason (optional, recorded on the audit trail)
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Launch wrapped up / pausing intake"
            className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm dark:border-amber-900/70 dark:bg-neutral-900"
          />
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={busy}
        className="rounded-md bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {archived
          ? busy
            ? "Restoring…"
            : "Restore launch"
          : busy
            ? "Archiving…"
            : "Archive launch"}
      </button>
    </section>
  );
}
