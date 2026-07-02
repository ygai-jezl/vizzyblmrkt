"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { listSchedulableNodes, friendlyScheduleError } from "@/lib/distribute/uiModel";
import { channelLabel } from "@/lib/content/channels";
import { ListView } from "./ListView";
import { CalendarView } from "./CalendarView";
import { SchedulePicker } from "./SchedulePicker";

type View = "list" | "calendar";

/**
 * Distribute pillar client. Renders the scheduled-post queue (List | Calendar)
 * and a picker to schedule approved Create nodes.
 *
 * Server data is the SINGLE source of truth: mutations POST/DELETE the schedule
 * route, then `router.refresh()` re-runs the force-dynamic page and repaints
 * `initialPlans`/`initialPosts`. We render straight from those props (no local
 * copy) so a refresh — or a change made elsewhere — always wins.
 */
export function DistributeClient({
  workspaceId,
  initialPlans,
  initialPosts,
}: {
  workspaceId: string;
  initialPlans: ContentPlan[];
  initialPosts: ScheduledPost[];
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("list");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards the double-dispatch window: `busy` only disables buttons after a
  // re-render, so a same-tick second click could fire before that lands.
  const inFlight = useRef(false);

  const base = `/api/admin/workspace/${workspaceId}/distribute/schedule`;

  const mutate = useCallback(
    async (method: "POST" | "DELETE", body: Record<string, string>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(base, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setError(friendlyScheduleError(d.error ?? `request_failed_${res.status}`));
          return;
        }
        router.refresh();
      } catch {
        setError(friendlyScheduleError("network_error"));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [base, router],
  );

  const schedule = useCallback(
    (contentPlanId: string, nodeId: string, scheduledAt: string) =>
      mutate("POST", { contentPlanId, nodeId, scheduledAt }),
    [mutate],
  );
  const reschedule = useCallback(
    (post: ScheduledPost, iso: string) => schedule(post.contentPlanId, post.nodeId, iso),
    [schedule],
  );
  const cancel = useCallback(
    (post: ScheduledPost) =>
      mutate("DELETE", { contentPlanId: post.contentPlanId, nodeId: post.nodeId }),
    [mutate],
  );

  const schedulable = useMemo(
    () => listSchedulableNodes(initialPlans, initialPosts),
    [initialPlans, initialPosts],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Distribute</h2>
          <p className="text-sm text-neutral-500">
            Schedule approved content onto a queue; the worker releases each item at its time.
            Times shown in UTC.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {busy ? (
            <span className="text-xs text-neutral-500" role="status">
              Working…
            </span>
          ) : null}
          <div className="flex gap-1 rounded-md border border-neutral-300 p-0.5 text-sm dark:border-neutral-700">
            {(["list", "calendar"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded px-3 py-1 capitalize ${
                  view === v
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* Schedule approved nodes */}
      <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <h3 className="text-sm font-medium">Ready to schedule</h3>
        {schedulable.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500">
            No approved, un-scheduled items. Generate + approve nodes in Create first.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {schedulable.map((s) => (
              <li
                key={`${s.planId}:${s.node.id}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs text-neutral-500">
                    {s.planName} · {channelLabel(s.node.channel)}
                  </div>
                  <div className="truncate text-sm text-neutral-700 dark:text-neutral-300">
                    {s.node.body.slice(0, 120)}
                    {s.node.body.length > 120 ? "…" : ""}
                  </div>
                </div>
                <SchedulePicker
                  label="Schedule"
                  disabled={busy}
                  onSubmit={(iso) => schedule(s.planId, s.node.id, iso)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {view === "list" ? (
        <ListView posts={initialPosts} onReschedule={reschedule} onCancel={cancel} busy={busy} />
      ) : (
        <CalendarView posts={initialPosts} onReschedule={reschedule} onCancel={cancel} busy={busy} />
      )}
    </div>
  );
}
