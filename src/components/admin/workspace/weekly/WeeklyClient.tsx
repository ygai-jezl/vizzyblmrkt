"use client";

import { useRef, useState } from "react";
import type { ReadyHub } from "@/lib/distribute/weeklyHubs";

/**
 * Weekly newsletter tab. Lists every ready hub newsletter across the workspace.
 * Pick one → confirm the subject + target launch → it's sent (as a MailChimp
 * broadcast) to that launch's weekly-newsletter audience — the opt-in subset who
 * reached a "weekly" Exit node. Assisted-manual: repeat each week.
 */
type Campaign = { id: string; name: string };

export function WeeklyClient({
  workspaceId,
  hubs,
  campaigns,
}: {
  workspaceId: string;
  hubs: ReadyHub[];
  campaigns: Campaign[];
}) {
  const [selected, setSelected] = useState<ReadyHub | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Weekly newsletter</h2>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500">
          Pick one of your generated newsletter hubs to send as this week&apos;s
          newsletter. It goes to the launch&apos;s weekly subscribers — the people
          who reached a &ldquo;weekly&rdquo; Exit node in that launch&apos;s
          journey. Come back each week to send the next one.
        </p>
      </div>

      {hubs.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          No ready newsletters yet. Generate a <span className="font-medium">newsletter hub</span>{" "}
          in the Create tab (a hub-and-spoke plan with a Newsletter hub), then it&apos;ll appear here.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {hubs.map((hub) => (
            <li
              key={`${hub.planId}:${hub.nodeId}`}
              className="flex flex-col rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold leading-snug">{hub.subject}</h3>
                {hub.scheduledAt ? (
                  <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">
                    scheduled
                  </span>
                ) : null}
              </div>
              <p className="mb-3 line-clamp-3 text-xs text-neutral-500">{hub.snippet}</p>
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="truncate text-[11px] text-neutral-400">{hub.planName}</span>
                <button
                  type="button"
                  onClick={() => setSelected(hub)}
                  className="shrink-0 rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
                >
                  Send this week
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <SendPanel
          hub={selected}
          campaigns={campaigns}
          workspaceId={workspaceId}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function SendPanel({
  hub,
  campaigns,
  workspaceId,
  onClose,
}: {
  hub: ReadyHub;
  campaigns: Campaign[];
  workspaceId: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(hub.subject);
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  // Empty ⇒ send now; a local datetime ⇒ schedule for that future instant.
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The broadcast is created ONCE and its id retained, so a retry (e.g. after an
  // ambiguous /send or /schedule response) reuses the same broadcast — those
  // routes are idempotent per-broadcast, preventing a duplicate campaign /
  // double-send / double-schedule. Reset when the target launch changes.
  const broadcastIdRef = useRef<string | null>(null);

  async function submit() {
    if (!campaignId || !subject.trim()) return;
    const scheduling = scheduledLocal.trim() !== "";
    let scheduledAtIso = "";
    if (scheduling) {
      const ms = new Date(scheduledLocal).getTime();
      if (Number.isNaN(ms) || ms <= Date.now()) {
        setMsg("Pick a future date and time.");
        return;
      }
      scheduledAtIso = new Date(ms).toISOString(); // tz-qualified (Z) for the route
    }
    setBusy(true);
    setMsg(null);
    try {
      if (!broadcastIdRef.current) {
        const createRes = await fetch(`/api/admin/campaigns/${campaignId}/broadcasts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Weekly · ${subject.trim()}`.slice(0, 140),
            subject: subject.trim(),
            body: hub.body, // snapshot the hub content at create
            audienceMode: "weekly",
            sourceWorkspaceId: workspaceId,
            sourcePlanId: hub.planId,
            sourceHubNodeId: hub.nodeId,
          }),
        });
        if (!createRes.ok) throw new Error("create_failed");
        const { broadcast } = await createRes.json();
        broadcastIdRef.current = broadcast.id as string;
      }
      const url = scheduling
        ? `/api/admin/campaigns/${campaignId}/broadcasts/${broadcastIdRef.current}/schedule`
        : `/api/admin/campaigns/${campaignId}/broadcasts/${broadcastIdRef.current}/send`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: scheduling ? JSON.stringify({ scheduledAt: scheduledAtIso }) : "{}",
      });
      if (!res.ok) throw new Error("failed");
      setBusy(false);
      setMsg(
        scheduling
          ? "Scheduled — it'll go to this launch's weekly subscribers at that time."
          : "Sent to this launch's weekly subscribers.",
      );
    } catch {
      setBusy(false);
      setMsg("Couldn't complete that — please try again.");
    }
  }

  const done = !!msg && (msg.startsWith("Sent") || msg.startsWith("Scheduled"));

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Send this week&apos;s newsletter</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-900"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Subject line
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <label className="mt-3 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Send to launch&apos;s weekly subscribers
          {campaigns.length === 0 ? (
            <p className="mt-1 text-xs font-normal text-neutral-500">
              No launches yet — create a launch first so there&apos;s an audience.
            </p>
          ) : (
            <select
              value={campaignId}
              onChange={(e) => {
                setCampaignId(e.target.value);
                broadcastIdRef.current = null; // different launch = a new broadcast
              }}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="mt-3 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Schedule for later (optional)
          <input
            type="datetime-local"
            value={scheduledLocal}
            onChange={(e) => setScheduledLocal(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block font-normal text-neutral-400">
            Leave empty to send now. It&apos;ll appear on the Distribute calendar.
          </span>
        </label>

        <p className="mt-2 text-[11px] leading-snug text-neutral-400">
          Goes only to subscribers who opted in via a &ldquo;weekly&rdquo; Exit
          node. If no one has opted in yet, the send is safely refused (no
          audience).
        </p>

        <div className="mt-4 flex items-center justify-end gap-2">
          {msg ? (
            <span className={`mr-auto text-xs ${done ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {msg}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {done ? "Done" : "Cancel"}
          </button>
          {!done ? (
            <button
              type="button"
              onClick={submit}
              disabled={busy || !campaignId || !subject.trim()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
            >
              {busy ? "Working…" : scheduledLocal.trim() ? "Schedule" : "Send now"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
