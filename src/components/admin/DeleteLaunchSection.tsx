"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Danger zone: permanently delete a launch. Mirrors the destructive contract of
 * the API — the operator must type the launch id to confirm (which the server
 * also re-checks via the `confirm` field), and an optional reason is recorded on
 * the immutable audit trail. On success we leave the (now-deleted) launch and
 * return to the launches home. Rendered only for admins; the route enforces the
 * role regardless.
 */
export function DeleteLaunchSection({
  campaignId,
  campaignName,
}: {
  campaignId: string;
  campaignName: string;
}) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "deleting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const armed = confirmText === campaignId && status !== "deleting";

  async function onDelete() {
    if (!armed) return;
    setStatus("deleting");
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: campaignId,
          reason: reason.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data.error === "forbidden"
            ? "Only an admin can delete a launch."
            : data.error === "campaign_not_found"
              ? "This launch no longer exists."
              : data.error === "confirmation_required"
                ? "Type the launch id exactly to confirm."
                : "Delete failed — please try again.",
        );
        setStatus("error");
        return;
      }
      // Purged. Leave the (now-gone) launch and refresh the launch list.
      router.push("/admin");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setStatus("error");
    }
  }

  return (
    <section className="mt-12 space-y-4 rounded-md border border-red-300 bg-red-50/40 p-5 dark:border-red-900/70 dark:bg-red-950/20">
      <div>
        <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">
          Delete this launch
        </h2>
        <p className="mt-1 text-sm text-red-700/90 dark:text-red-300/80">
          Permanently deletes <span className="font-medium">{campaignName}</span>{" "}
          and purges all of its data — every signup, the leaderboard, broadcasts,
          journeys, and queued emails. This cannot be undone. An audit record (who,
          when, how many records, and your reason) is kept for compliance.
        </p>
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium text-red-800 dark:text-red-300">
          Reason (optional, recorded on the audit trail)
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Test launch / off-boarding the brand"
          className="w-full rounded-md border border-red-300 bg-white px-3 py-2 text-sm dark:border-red-900/70 dark:bg-neutral-900"
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium text-red-800 dark:text-red-300">
          Type{" "}
          <code className="rounded bg-red-100 px-1 py-0.5 font-mono text-xs text-red-900 dark:bg-red-900/40 dark:text-red-200">
            {campaignId}
          </code>{" "}
          to confirm
        </label>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Type the launch id to confirm deletion"
          className="w-full rounded-md border border-red-300 bg-white px-3 py-2 font-mono text-sm dark:border-red-900/70 dark:bg-neutral-900"
        />
      </div>

      {error ? (
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={onDelete}
        disabled={!armed}
        className="rounded-md bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "deleting" ? "Deleting…" : "Permanently delete launch"}
      </button>
    </section>
  );
}
