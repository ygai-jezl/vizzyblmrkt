"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import {
  listSchedulableNodes,
  friendlyScheduleError,
  type CalendarNewsletter,
} from "@/lib/distribute/uiModel";
import { scorePPS } from "@/lib/distribute/pps";
import { channelLabel } from "@/lib/content/channels";
import { PpsGauge } from "./PpsGauge";
import { ListView } from "./ListView";
import { CalendarView } from "./CalendarView";
import { SchedulePicker } from "./SchedulePicker";
import { PreviewToggle } from "./preview/PreviewToggle";

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
  initialNewsletters = [],
}: {
  workspaceId: string;
  initialPlans: ContentPlan[];
  initialPosts: ScheduledPost[];
  initialNewsletters?: CalendarNewsletter[];
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
    async (
      method: "POST" | "DELETE" | "PATCH",
      body: Record<string, string>,
      url: string = base,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
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
    (contentPlanId: string, nodeId: string, scheduledAt: string, linkedInAuthorUrn?: string | null) =>
      mutate("POST", {
        contentPlanId,
        nodeId,
        scheduledAt,
        ...(linkedInAuthorUrn ? { linkedInAuthorUrn } : {}),
      }),
    [mutate],
  );
  const reschedule = useCallback(
    (post: ScheduledPost, iso: string, linkedInAuthorUrn?: string | null) =>
      schedule(post.contentPlanId, post.nodeId, iso, linkedInAuthorUrn),
    [schedule],
  );
  const cancel = useCallback(
    (post: ScheduledPost) =>
      mutate("DELETE", { contentPlanId: post.contentPlanId, nodeId: post.nodeId }),
    [mutate],
  );
  // Set/clear the recycling template on a scheduled post. PATCH (not the schedule
  // re-arm) so it never touches the post's time (no must_be_future on an overdue
  // post) or its retry/failed state.
  const setSpintax = useCallback(
    (post: ScheduledPost, source: string) =>
      mutate("PATCH", {
        contentPlanId: post.contentPlanId,
        nodeId: post.nodeId,
        spintaxSource: source,
      }),
    [mutate],
  );
  // Build a carousel (Gemini slide images) for a LinkedIn/Instagram post. Hits the
  // separate carousel endpoint (flag-gated 503 when unprovisioned → friendly error).
  const carouselUrl = `/api/admin/workspace/${workspaceId}/distribute/carousel`;
  const buildCarousel = useCallback(
    (post: ScheduledPost) =>
      mutate("POST", { contentPlanId: post.contentPlanId, nodeId: post.nodeId }, carouselUrl),
    [mutate, carouselUrl],
  );

  const schedulable = useMemo(
    () => listSchedulableNodes(initialPlans, initialPosts),
    [initialPlans, initialPosts],
  );
  // Score each row once (not on every unrelated re-render, e.g. busy/view toggles).
  const scoredSchedulable = useMemo(
    () => schedulable.map((s) => ({ ...s, pps: scorePPS(s.node.body, s.node.channel) })),
    [schedulable],
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
        {scoredSchedulable.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500">
            No approved, un-scheduled items. Generate + approve nodes in Create first.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {scoredSchedulable.map((s) => (
              <li
                key={`${s.planId}:${s.node.id}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <span>
                      {s.planName} · {channelLabel(s.node.channel)}
                    </span>
                    <PpsGauge pps={s.pps} />
                  </div>
                  <div className="truncate text-sm text-neutral-700 dark:text-neutral-300">
                    {s.node.body.slice(0, 120)}
                    {s.node.body.length > 120 ? "…" : ""}
                  </div>
                  <div className="mt-1">
                    <PreviewToggle channel={s.node.channel} body={s.node.body} />
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
        <ListView
          posts={initialPosts}
          newsletters={initialNewsletters}
          onReschedule={reschedule}
          onCancel={cancel}
          onSetSpintax={setSpintax}
          onBuildCarousel={buildCarousel}
          busy={busy}
        />
      ) : (
        <CalendarView
          posts={initialPosts}
          newsletters={initialNewsletters}
          onReschedule={reschedule}
          onCancel={cancel}
          onSetSpintax={setSpintax}
          onBuildCarousel={buildCarousel}
          busy={busy}
        />
      )}
    </div>
  );
}
