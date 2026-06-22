"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Broadcast } from "@/lib/types/broadcast";
import { Modal } from "./Modal";
import { EmailComposer, type EmailComposerValue } from "./EmailComposer";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  scheduled: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  queued: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  sending: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  sent: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const EMPTY: EmailComposerValue = { subject: "", body: "", heroImageUrl: null };

/** Furthest ahead a broadcast may be scheduled — mirrors the server's cap. */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** Server error codes → operator-facing copy for the schedule action. */
const SCHEDULE_ERRORS: Record<string, string> = {
  must_be_future: "Pick a time in the future.",
  too_far_ahead: "Pick a time within the next year.",
  not_schedulable: "This broadcast is already sending and can't be scheduled.",
  launch_archived: "This launch is closed — reopen it before scheduling.",
};

/** Format a Date as a `datetime-local` input value in the browser's timezone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function BroadcastsView({
  campaignId,
  initial,
}: {
  campaignId: string;
  initial: Broadcast[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState<EmailComposerValue>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Schedule modal state (separate from the composer modal).
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);

  // Local-time labels are computed client-side only; render a stable placeholder
  // during SSR/first paint so hydration matches, then swap to the operator's tz.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  function fmtWhen(iso: string): string {
    if (!mounted) return `${iso.slice(0, 16).replace("T", " ")} UTC`;
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  const rows = initial;

  function openNew() {
    setEditingId(null);
    setName("");
    setValue(EMPTY);
    setError(null);
    setOpen(true);
  }

  function openEdit(b: Broadcast) {
    setEditingId(b.id);
    setName(b.name);
    setValue({
      subject: b.subject,
      body: b.body,
      heroImageUrl: b.heroImageUrl ?? null,
      agentMeta: b.agentMeta,
    });
    setError(null);
    setOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      setError("Give this broadcast a name.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      subject: value.subject,
      body: value.body,
      heroImageUrl: value.heroImageUrl ?? null,
      agentMeta: value.agentMeta,
    };
    const url = editingId
      ? `/api/admin/campaigns/${campaignId}/broadcasts/${editingId}`
      : `/api/admin/campaigns/${campaignId}/broadcasts`;
    const res = await fetch(url, {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setError("Save failed. Please try again.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  async function send(b: Broadcast) {
    if (!window.confirm(`Send "${b.name}" to this launch's subscribers now?`)) return;
    setBusyId(b.id);
    const res = await fetch(
      `/api/admin/campaigns/${campaignId}/broadcasts/${b.id}/send`,
      { method: "POST" },
    );
    const data = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok || data.status === "failed") {
      window.alert(
        `Send failed${data.lastError ? `: ${data.lastError}` : ""}. Check your MailChimp config.`,
      );
    }
    router.refresh();
  }

  function openSchedule(b: Broadcast) {
    setScheduleId(b.id);
    // Re-scheduling preselects the current time; a fresh schedule defaults to +1h.
    const base = b.scheduledAt
      ? new Date(b.scheduledAt)
      : new Date(Date.now() + 60 * 60 * 1000);
    setScheduleAt(toLocalInput(base));
    setScheduleErr(null);
  }

  async function confirmSchedule() {
    if (!scheduleId) return;
    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime())) {
      setScheduleErr("Pick a valid date & time.");
      return;
    }
    if (when.getTime() <= Date.now()) {
      setScheduleErr("Pick a time in the future.");
      return;
    }
    if (when.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
      setScheduleErr("Pick a time within the next year.");
      return;
    }
    setScheduleBusy(true);
    setScheduleErr(null);
    const res = await fetch(
      `/api/admin/campaigns/${campaignId}/broadcasts/${scheduleId}/schedule`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledAt: when.toISOString() }),
      },
    );
    setScheduleBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as { error?: string });
      setScheduleErr(
        SCHEDULE_ERRORS[data.error ?? ""] ?? "Could not schedule. Please try again.",
      );
      return;
    }
    setScheduleId(null);
    router.refresh();
  }

  async function cancelSchedule(b: Broadcast) {
    if (
      !window.confirm(
        `Cancel the scheduled send of "${b.name}"? It will return to draft.`,
      )
    )
      return;
    setBusyId(b.id);
    const res = await fetch(
      `/api/admin/campaigns/${campaignId}/broadcasts/${b.id}/schedule`,
      { method: "DELETE" },
    );
    setBusyId(null);
    if (!res.ok) {
      window.alert("Could not cancel — it may already be sending.");
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500">
          One-off emails to this launch&apos;s audience.
        </p>
        <button
          type="button"
          onClick={openNew}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
        >
          + New Broadcast
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No broadcasts yet. Create one to email this launch&apos;s subscribers.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Open rate</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const editable = b.status === "draft" || b.status === "failed";
                const scheduled = b.status === "scheduled";
                return (
                  <tr
                    key={b.id}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2">{b.name}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLES[b.status] ?? STATUS_STYLES.draft
                        }`}
                      >
                        {b.status}
                      </span>
                      {scheduled && b.scheduledAt ? (
                        <span className="mt-1 block text-xs text-neutral-500">
                          {fmtWhen(b.scheduledAt)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                      {b.stats?.openRate != null
                        ? `${Math.round(b.stats.openRate * 100)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-neutral-500">
                      {b.sentAt ? b.sentAt.slice(0, 10) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        {editable ? (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(b)}
                              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => openSchedule(b)}
                              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                            >
                              Schedule
                            </button>
                            <button
                              type="button"
                              disabled={busyId === b.id}
                              onClick={() => send(b)}
                              className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
                            >
                              {busyId === b.id ? "Sending…" : "Send"}
                            </button>
                          </>
                        ) : null}
                        {scheduled ? (
                          <>
                            <button
                              type="button"
                              disabled={busyId === b.id}
                              onClick={() => cancelSchedule(b)}
                              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={busyId === b.id}
                              onClick={() => send(b)}
                              className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
                            >
                              {busyId === b.id ? "Sending…" : "Send now"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? "Edit broadcast" : "New broadcast"}
        wide
      >
        <div className="space-y-4">
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Name (internal)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Launch week teaser"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <EmailComposer
            mode="broadcast"
            campaignId={campaignId}
            value={value}
            onChange={setValue}
          />

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={scheduleId !== null}
        onClose={() => setScheduleId(null)}
        title="Schedule broadcast"
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-500">
            Pick when this broadcast should go out. It stays a draft until then and
            sends automatically at the chosen time (your timezone).
          </p>
          <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Send at
            <input
              type="datetime-local"
              value={scheduleAt}
              min={toLocalInput(new Date())}
              max={toLocalInput(new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS))}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          {scheduleErr ? (
            <p className="text-sm text-red-600 dark:text-red-400">{scheduleErr}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setScheduleId(null)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmSchedule}
              disabled={scheduleBusy}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
            >
              {scheduleBusy ? "Scheduling…" : "Schedule send"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
