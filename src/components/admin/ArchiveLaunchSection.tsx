"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

const PHASE3 = isNavV2Phase3Enabled();

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
  journeyPaused = false,
  waiting = null,
  holdOnPause = false,
}: {
  campaignId: string;
  campaignName: string;
  archived: boolean;
  /** The launch's welcome journey is paused (archiving pauses it; restoring doesn't resume it). */
  journeyPaused?: boolean;
  /** People waiting part-way through the paused journey (engine move D1); null = unknown. */
  waiting?: number | null;
  /** WAITLIST_JOURNEY_HOLD_ON_PAUSE: waiting people carry on when it's turned back on. */
  holdOnPause?: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const action = archived ? "restore" : "archive";
  const busy = status === "working";
  const [resume, setResume] = useState<"idle" | "working" | "done">("idle");
  const [resumed, setResumed] = useState<string | null>(null);

  /** Nav v2 phase 3: after a restore, turn the paused welcome emails back on in one step. */
  async function resumeJourney() {
    setResume("working");
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/journey/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        held?: { released: number; expired: number; stepRemoved: number };
        /** A launch on the lifecycle engine (engine move): people who waited there. */
        moved?: { released: number; expired: number };
      };
      if (!res.ok) {
        setError(
          data.error === "journey_invalid"
            ? `The journey can't be published yet${data.reason ? `: ${data.reason}` : ""}. Fix it on the Journey page.`
            : data.error === "launch_archived"
              ? "Restore the launch first, then turn its welcome emails back on."
              : "Couldn't turn the emails back on — please try again.",
        );
        setResume("idle");
        return;
      }
      const released = (data.held?.released ?? 0) + (data.moved?.released ?? 0);
      setResumed(
        released
          ? `Welcome emails are back on. ${released} waiting ${released === 1 ? "person gets" : "people get"} their next email.`
          : "Welcome emails are back on.",
      );
      setResume("done");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setResume("idle");
    }
  }

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
    <>
    {PHASE3 && !archived && journeyPaused && resume !== "done" ? (
      <section className="mt-8 space-y-3 rounded-md border border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-sm font-semibold">Welcome emails are paused</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {campaignName}&rsquo;s welcome &amp; nurture journey isn&rsquo;t sending.{" "}
            {holdOnPause
              ? waiting
                ? `${waiting.toLocaleString("en-GB")} ${waiting === 1 ? "person is" : "people are"} waiting part-way through. Turning it back on sends each of them their next email, and new signups get the welcome.`
                : "Turning it back on sends new signups the welcome, and anyone waiting part-way through their next email."
              : "Turning it back on emails new signups again. People who were part-way through when it paused won't get the rest."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void resumeJourney()}
          disabled={resume === "working"}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {resume === "working" ? "Turning on…" : "Turn welcome emails back on"}
        </button>
      </section>
    ) : null}
    {PHASE3 && resume === "done" && resumed ? (
      <p
        role="status"
        className="mt-8 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
      >
        {resumed}
      </p>
    ) : null}
    <section className="mt-8 space-y-4 rounded-md border border-amber-300 bg-amber-50/40 p-5 dark:border-amber-900/70 dark:bg-amber-950/20">
      {archived ? (
        <div>
          <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Restore this launch
          </h2>
          <p className="mt-1 text-sm text-amber-700/90 dark:text-amber-300/80">
            <span className="font-medium">{campaignName}</span> is archived — its
            public waitlist is closed to new signups. Restoring reopens signups
            immediately.{" "}
            {PHASE3 ? (
              "If its welcome emails were paused, you can turn them back on here once it's restored."
            ) : (
              <>
                Note: paused email journeys are <span className="font-medium">not</span> resumed automatically —
                re-activate them from the Journey page.
              </>
            )}
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
    </>
  );
}
