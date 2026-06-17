"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Broadcast } from "@/lib/types/broadcast";
import { Modal } from "./Modal";
import { EmailComposer, type EmailComposerValue } from "./EmailComposer";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  queued: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  sending: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  sent: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const EMPTY: EmailComposerValue = { subject: "", body: "", heroImageUrl: null };

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
                          <button
                            type="button"
                            onClick={() => openEdit(b)}
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                          >
                            Edit
                          </button>
                        ) : null}
                        {editable ? (
                          <button
                            type="button"
                            disabled={busyId === b.id}
                            onClick={() => send(b)}
                            className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
                          >
                            {busyId === b.id ? "Sending…" : "Send"}
                          </button>
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
    </div>
  );
}
