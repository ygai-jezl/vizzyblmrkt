"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/components/admin/connect/api";
import { strategyErrorText } from "@/components/admin/brand-kit/strategyMessages";
import { SUGGEST_WORDS as W } from "@/lib/brandStrategy/suggestRules";
import { NOT_NOW_REASONS, STRATEGY_SUGGEST_LIMITS, type NotNowReason } from "@/lib/types/brandStrategy";

const PATH = "/api/admin/brand-kit/map/strategy/suggestion/dismiss";

/** A reason chip, pressed or not, as the "why" chips elsewhere (PassReasonDialog, the image rating). */
const chip = (on: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-xs ${
    on
      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
      : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
  }`;

/**
 * Not now on the month's strategy suggestion (STRATEGY_SUGGEST_ENABLED), admins only: asks why in a
 * tap (Not a priority, Already doing it, The numbers are wrong, Other) with an optional note of 200
 * characters, then puts it off: 60 days, or 90 for one about connecting a tool. On Review the list is
 * shown again without it; on the Strategy tab `onDone` reads the tab again.
 */
export function SuggestNotNow({ suggestionKey, onDone }: { suggestionKey: string; onDone?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<NotNowReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const r = await api(PATH, { method: "POST", body: JSON.stringify({ key: suggestionKey, reason, ...(note.trim() ? { note: note.trim() } : {}) }) });
    setBusy(false);
    if (!r.ok) return setError(strategyErrorText(r.data));
    setOpen(false);
    if (onDone) onDone();
    else router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink">
        {W.notNow}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-shell-line p-2 sm:w-72" role="group" aria-label={W.notNowAsk}>
      <p className="text-xs font-medium">{W.notNowAsk}</p>
      <div className="flex flex-wrap gap-1.5">
        {NOT_NOW_REASONS.map((r) => (
          <button key={r} type="button" aria-pressed={reason === r} className={chip(reason === r)} onClick={() => setReason(reason === r ? null : r)}>
            {W.reasons[r]}
          </button>
        ))}
      </div>
      <input
        aria-label={W.notePlaceholder}
        placeholder={W.notePlaceholder}
        maxLength={STRATEGY_SUGGEST_LIMITS.note}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="rounded border border-shell-line bg-transparent px-2 py-1 text-xs"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2.5 py-1 text-xs text-shell-muted hover:bg-shell-hover">
          {W.cancel}
        </button>
        <button type="button" disabled={!reason || busy} onClick={() => void save()} className="rounded-md border border-shell-line px-2.5 py-1 text-xs font-medium hover:bg-shell-hover disabled:opacity-50">
          {busy ? "Saving…" : W.save}
        </button>
      </div>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
