"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, inputClass } from "@/components/admin/connect/ui";
import type { WorkRead } from "@/lib/work/types";
import { workCall, workErrorText } from "./api";

/** The one tap read on a measure's check, in the order drawn. */
export const READ_BUTTONS: ReadonlyArray<{ read: WorkRead; label: string }> = [
  { read: "better", label: "Better" },
  { read: "same", label: "Same" },
  { read: "worse", label: "Worse" },
  { read: "too_soon", label: "Too soon to tell" },
];

export type CheckSend = { action: "checked" } | { action: "look_again"; day?: string; time?: string } | { action: "read"; read: WorkRead };

/** What each button says, and whether it waits, while one is being sent. */
export function checkButtons(byMeasure: boolean, busy: string | null): Array<{ key: string; label: string; disabled: boolean }> {
  if (byMeasure) return READ_BUTTONS.map((b) => ({ key: b.read, label: busy === b.read ? "Saving…" : b.label, disabled: busy !== null }));
  return [
    { key: "checked", label: busy === "checked" ? "Saving…" : "Mark checked", disabled: busy !== null },
    { key: "look_again", label: busy === "look_again" ? "Saving…" : "Look again tomorrow", disabled: busy !== null },
  ];
}

/** What a check's answer says, or "Checked." when Work set nothing next. */
export const checkNoticeOf = (notice: string | null | undefined): string => notice ?? "Checked.";

/**
 * A check's buttons: on a measure's check the read (Better, Same, Worse, Too soon to tell), else
 * Mark checked and Look again tomorrow. Too soon to tell asks again 7 days on; the person can pick
 * another day after. The answer's notice says what Work set next. The page reads itself again
 * after an answer, and an answered check is no longer due, so these buttons go: a page passes
 * `onSaid` to keep the notice somewhere that stays.
 */
export function CheckActions({
  taskRef,
  byMeasure,
  via,
  compact = false,
  onSaid,
}: {
  taskRef: number;
  byMeasure: boolean;
  via: "work_page" | "today";
  compact?: boolean;
  onSaid?: (notice: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(body: CheckSend, key: string) {
    setBusy(key);
    setError(null);
    const r = await workCall<{ notice: string | null }>("/checks", "POST", { ref: taskRef, ...body, via });
    setBusy(null);
    if (!r.ok) return setError(workErrorText(r.data));
    const notice = checkNoticeOf(r.data.notice);
    if (onSaid) onSaid(notice);
    else setSaid(notice);
    router.refresh();
  }

  if (said) {
    return (
      <p role="status" className="text-sm text-neutral-600 dark:text-neutral-300">
        {said}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={byMeasure ? "Did it work? Your read" : "This check"} className="flex flex-wrap items-center gap-1.5">
        {byMeasure && !compact ? <span className="text-sm font-medium">Your read:</span> : null}
        {checkButtons(byMeasure, busy).map((b) => (
          <Button
            key={b.key}
            disabled={b.disabled}
            onClick={() => void send(b.key === "checked" ? { action: "checked" } : b.key === "look_again" ? { action: "look_again" } : { action: "read", read: b.key as WorkRead }, b.key)}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Move a check to another day and time: a measure's check keeps asking about its measure. */
export function MoveCheck({ taskRef, today, onClose }: { taskRef: number; today: string; onClose: () => void }) {
  const router = useRouter();
  const [day, setDay] = useState(today);
  const [time, setTime] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    const r = await workCall("/checks", "POST", { ref: taskRef, action: "look_again", day, ...(time !== "08:00" ? { time } : {}), via: "work_page" });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    onClose();
    router.refresh();
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <input type="date" aria-label="Date" min={today} value={day} onChange={(e) => setDay(e.target.value)} className={`${inputClass} w-auto`} />
        <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value || "08:00")} className={`${inputClass} w-auto`} />
        <Button tone="primary" disabled={busy || !day} onClick={() => void save()}>
          {busy ? "Saving…" : "Move it"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
