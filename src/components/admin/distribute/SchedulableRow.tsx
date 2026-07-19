"use client";

import { useState } from "react";
import type { SchedulableNode } from "@/lib/distribute/uiModel";
import type { PpsResult } from "@/lib/distribute/pps";
import { channelLabel } from "@/lib/content/channels";
import { PpsGauge } from "./PpsGauge";
import { PreviewToggle } from "./preview/PreviewToggle";
import { SchedulePicker } from "./SchedulePicker";
import { LinkedInAuthorSelect } from "./LinkedInAuthorSelect";

/**
 * One "Ready to schedule" row. Owns its LinkedIn "Post as" selection so the Company
 * Page can be chosen AT schedule time (not only after, on the queued card) — the org
 * URN rides along with the initial schedule. Mirrors PostCard's author-state pattern.
 */
export function SchedulableRow({
  item,
  busy,
  onSchedule,
}: {
  item: SchedulableNode & { pps: PpsResult };
  busy: boolean;
  onSchedule: (
    planId: string,
    nodeId: string,
    iso: string,
    linkedInAuthorUrn?: string | null,
  ) => void;
}) {
  const isLinkedIn = item.node.channel === "linkedin";
  // "Post as" (LinkedIn): the org URN to publish as, or null = the connected member.
  // LinkedInAuthorSelect defaults this to the sole/first Page for a Company-Page-only
  // tenant, so a plain Schedule publishes as the Page instead of parking.
  const [author, setAuthor] = useState<string | null>(null);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>
            {item.planName} · {channelLabel(item.node.channel)}
          </span>
          <PpsGauge pps={item.pps} />
        </div>
        <div className="truncate text-sm text-neutral-700 dark:text-neutral-300">
          {item.node.body.slice(0, 120)}
          {item.node.body.length > 120 ? "…" : ""}
        </div>
        <div className="mt-1">
          <PreviewToggle channel={item.node.channel} body={item.node.body} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isLinkedIn ? (
          <LinkedInAuthorSelect value={author} onChange={setAuthor} disabled={busy} />
        ) : null}
        <SchedulePicker
          label="Schedule"
          disabled={busy}
          onSubmit={(iso) => onSchedule(item.planId, item.node.id, iso, isLinkedIn ? author : null)}
        />
      </div>
    </li>
  );
}
