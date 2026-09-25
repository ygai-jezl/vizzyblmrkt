"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText, timeAgo, type ProductEvent } from "./api";
import { Badge, Banner, Button } from "./ui";

interface Rejection {
  at: string;
  messageId?: string | null;
  reason: string;
}

const POLL_MS = 5000;

/**
 * Live view of what a product is sending: the latest writes, milestones and
 * erasures — including writes that changed nothing because YouGrow held something
 * newer — and the most recent rejections (with the reason, so an integrator can fix
 * them).
 */

/** v2 state writes are "identify" rows with a `v2:` message id. */
function messageLabel(e: ProductEvent) {
  if (e.type === "track") return <span className="font-mono">{e.event}</span>;
  if (e.type === "erase") return <Badge>erased</Badge>;
  return <Badge>{e.messageId.startsWith("v2:") ? "state update" : "identify"}</Badge>;
}

const SKIPPED: Record<string, string> = {
  stale_write: "Older than the state YouGrow holds",
  deleted_later: "Older than a later deletion",
};
export function EventDebugger({ connectionId, compact = false }: { connectionId: string; compact?: boolean }) {
  const [events, setEvents] = useState<ProductEvent[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const load = useCallback(async () => {
    const r = await api<{ events: ProductEvent[]; rejections: Rejection[] }>(
      `/api/admin/connections/${connectionId}/events?limit=${compact ? 10 : 50}`,
    );
    if (!r.ok) return setError(errorText(r.data));
    setError(null);
    setEvents(r.data.events);
    setRejections(r.data.rejections);
  }, [connectionId, compact]);

  useEffect(() => {
    void load();
    if (!live) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load, live]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-green-500" : "bg-neutral-400"}`} />
          {live ? "Listening" : "Paused"}
        </span>
        <Button onClick={() => setLive((v) => !v)}>{live ? "Pause" : "Resume"}</Button>
      </div>
      {error ? <Banner tone="err">{error}</Banner> : null}

      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">Received</th>
              <th className="px-3 py-2 font-medium">Message</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Applied</th>
              {!compact ? <th className="px-3 py-2 font-medium">Payload</th> : null}
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-neutral-500">
                  No events yet.
                </td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.id} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{timeAgo(e.receivedAt)}</td>
                  <td className="px-3 py-2">{messageLabel(e)}</td>
                  <td className="max-w-[10rem] truncate px-3 py-2 font-mono">{e.externalUserId || "—"}</td>
                  <td className="px-3 py-2">
                    {e.applied ? "✓" : <span title={SKIPPED[e.skipped ?? "stale_write"]}>— {e.skipped ? e.skipped.replace(/_/g, " ") : ""}</span>}
                  </td>
                  {!compact ? (
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-neutral-500">
                      {JSON.stringify(e.payload)}
                      {e.ignoredFields?.length ? <span className="text-amber-700 dark:text-amber-400"> · ignored: {e.ignoredFields.join(", ")}</span> : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {rejections.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-red-700 dark:text-red-400">Recent rejections</h4>
          <ul className="space-y-1">
            {rejections.slice(0, compact ? 5 : 20).map((r, i) => (
              <li key={`${r.at}-${i}`} className="text-xs text-neutral-600 dark:text-neutral-400">
                <span className="text-neutral-400">{timeAgo(r.at)}</span>{" "}
                {r.messageId ? <span className="font-mono">{r.messageId}</span> : null} — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
