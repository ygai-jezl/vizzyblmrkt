"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordFieldObject } from "@/lib/types/recordField";
import { api } from "../connect/api";
import { Banner, Button, inputClass } from "../connect/ui";
import { Dialog, DialogTable } from "./Dialog";
import { ERASE_COPY, eraseErrorText, whenText } from "./historyWords";

interface Counts {
  records: number;
  events: number;
  agentActions: number;
}
interface Job {
  mode: "count" | "erase";
  state: "running" | "done" | "failed" | "stopped";
  phase: "records" | "events" | "actions" | "finish";
  counts: Counts;
  counted: (Counts & { at: string }) | null;
  scanned: number;
  finishedAt: string | null;
}
interface Status {
  allowed: boolean;
  refused?: string;
  field: { label: string; archivedAt: string | null; archivedBy: string | null; erasedAt: string | null; erasing: boolean };
  job: Job | null;
  countStands: boolean;
}

const n = (x: number) => x.toLocaleString("en-GB");
const POLL_MS = 8_000;

/**
 * Erase values (SETTINGS_ERASE_ENABLED), for an owner with an admin row: the first press starts a
 * count in the background; once it is done, the confirm shows the counts and asks for the field's
 * name; then the erase runs in the background, a page at a time, and this shows how far it is.
 */
export function EraseDialog({ object, fieldId, onClose, onChanged }: { object: RecordFieldObject; fieldId: string; onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The page's own callback changes as it re-renders; the dialog keeps the latest without re-running.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const opened = useRef(false);

  const load = useCallback(async () => {
    const r = await api<Status>(`/api/admin/settings-history/erase?object=${object}&fieldId=${fieldId}`);
    if (!r.ok) return setError(eraseErrorText(r.data));
    setStatus(r.data);
    return r.data;
  }, [object, fieldId]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      const r = await api<{ job?: Job; error?: string }>("/api/admin/settings-history/erase", { method: "POST", body: JSON.stringify({ object, fieldId, ...body }) });
      setBusy(false);
      if (!r.ok) return setError(eraseErrorText(r.data));
      await load();
      changed.current();
    },
    [object, fieldId, load],
  );

  // Open: read where it stands, and start a count when none stands and nothing runs. Once.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void (async () => {
      const s = await load();
      if (s && s.allowed && !s.countStands && s.job?.state !== "running" && !(s.job?.mode === "erase" && s.job.state === "failed")) await post({ action: "count" });
    })();
  }, [load, post]);

  const running = status?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const label = status?.field.label ?? "";
  const job = status?.job ?? null;
  const each = object === "person" ? "person" : "company";
  const confirm = !!status && status.allowed && !running && (status.countStands || (job?.mode === "erase" && job.state === "failed"));
  const counts = job?.mode === "erase" ? job.counted : job?.mode === "count" ? { ...job.counts, at: job.finishedAt ?? "" } : null;
  const sub =
    confirm && counts && status.field.archivedAt ? ERASE_COPY.countedLine(whenText(counts.at), whenText(status.field.archivedAt), status.field.archivedBy) : undefined;

  return (
    <Dialog title={ERASE_COPY.title(label || "this field")} sub={sub} busy={busy} onClose={onClose}>
      {error ? <Banner tone="err">{error}</Banner> : null}
      {!status ? (
        error ? null : <p className="text-sm text-neutral-500">Loading…</p>
      ) : job?.state === "done" && job.mode === "erase" ? (
        <Banner tone="ok">{ERASE_COPY.done(label)}</Banner>
      ) : job?.state === "stopped" && job.mode === "erase" ? (
        <Banner tone="info">{ERASE_COPY.stopped}</Banner>
      ) : running && job?.mode === "count" ? (
        <div className="space-y-2 text-sm">
          <p>{ERASE_COPY.counting}</p>
          <p className="text-neutral-500">{ERASE_COPY.lookedAt(n(job.scanned))}</p>
        </div>
      ) : running && job?.mode === "erase" ? (
        <p className="text-sm">{job.phase === "records" ? ERASE_COPY.progress(n(job.counts.records), n(job.counted?.records ?? job.counts.records)) : ERASE_COPY.blanking}</p>
      ) : confirm && counts ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [counts.records * (object === "person" ? 1 : 0), "people hold a value"],
              [counts.records * (object === "company" ? 1 : 0), "companies"],
              [counts.events, "history entries name it"],
              [counts.agentActions, "Vizzy suggestions"],
            ].map(([value, what]) => (
              <div key={what as string} className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <div className="text-lg font-semibold tabular-nums">{n(value as number)}</div>
                <div className="text-xs text-neutral-500">{what}</div>
              </div>
            ))}
          </div>
          <DialogTable
            rows={[
              { label: "Goes for good", lines: [ERASE_COPY.goesForGood(each)] },
              { label: "Stays", lines: [ERASE_COPY.stays] },
              { label: "Until then", lines: [ERASE_COPY.untilThen] },
            ]}
          />
          {job?.state === "failed" ? <Banner tone="info">{ERASE_COPY.failed}</Banner> : null}
          <label className="block space-y-1 text-sm">
            <span>
              Type <strong>{label}</strong> {ERASE_COPY.typeToConfirm}
            </span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoComplete="off" />
          </label>
          <p className="text-xs text-neutral-500">{ERASE_COPY.background}</p>
          <div className="flex flex-wrap items-center gap-2">
            {job?.mode === "count" ? (
              <Button disabled={busy} onClick={() => void post({ action: "count" })}>
                {ERASE_COPY.countAgain}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <button
              type="button"
              disabled={busy || name.trim() !== label}
              onClick={() => void post({ action: "erase", name })}
              className="inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500 dark:hover:bg-red-600"
            >
              {job?.state === "failed" ? ERASE_COPY.tryAgain : ERASE_COPY.action}
            </button>
          </div>
        </>
      ) : !status.allowed ? (
        <Banner tone="info">{eraseErrorText({ error: status.refused })}</Banner>
      ) : (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
    </Dialog>
  );
}
