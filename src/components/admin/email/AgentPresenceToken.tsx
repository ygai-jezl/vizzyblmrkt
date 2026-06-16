"use client";

import type { AgentMeta } from "@/lib/types/email";

/**
 * Agent Presence Token — the visual marker that a block of content was generated
 * or edited by Agent 3 (Creative Director). Shows a "drafting" state while a
 * generation is in flight.
 */
export function AgentPresenceToken({
  meta,
  busy,
}: {
  meta?: AgentMeta;
  busy?: boolean;
}) {
  if (busy) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
        <span className="animate-pulse">✨</span> Agent 3 is drafting…
      </span>
    );
  }
  if (meta?.source === "agent3") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
        title={meta.at ? `Drafted by Agent 3 · ${meta.at}` : "Drafted by Agent 3"}
      >
        ✨ Drafted by Agent 3
      </span>
    );
  }
  return null;
}
