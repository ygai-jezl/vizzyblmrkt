"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/components/admin/connect/api";
import type { ReviewItem } from "@/lib/review/summary";

/**
 * Review: a suggestion from collected numbers (CONNECTOR_SIGNALS_ENABLED), modelled on
 * MarkSeenButton. Plan an article opens Create with the question, page or search filled in (in the
 * programme chosen, when there are several); Dismiss takes the row away and says it stays away 30
 * days. Admins only: the page draws it only for them. Each button has its own busy state: while one
 * is sent, the other is disabled and keeps its words.
 */

const GHOST = "rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50";
const ACT = "shrink-0 rounded-md border border-shell-line px-3 py-1.5 text-sm font-medium hover:bg-shell-hover disabled:opacity-50";

type Answer = { ok?: boolean; href?: string; message?: string };

/** Which decision is being sent, if any. */
export type SignalBusy = "approve" | "dismiss" | null;

/**
 * What each button says and whether it can be pressed. Each has its own busy state: the one being
 * sent says so, and the other is disabled while it runs, its words unchanged.
 */
export function signalButtons(busy: SignalBusy): { plan: { label: string; disabled: boolean }; dismiss: { label: string; disabled: boolean } } {
  return {
    plan: { label: busy === "approve" ? "Planning…" : "Plan an article", disabled: busy !== null },
    dismiss: { label: busy === "dismiss" ? "Dismissing…" : "Dismiss", disabled: busy !== null },
  };
}

type RowItem = ReviewItem & { signal: { id: string } };

export function SignalRow({ item, programmes, programmeWord }: { item: RowItem; programmes: Array<{ id: string; name: string }>; programmeWord: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<SignalBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const path = `/api/admin/data-signals/${encodeURIComponent(item.signal.id)}`;

  async function post(what: "approve" | "dismiss", body: Record<string, unknown> = {}): Promise<Answer | null> {
    setBusy(what);
    setError(null);
    const r = await api<Answer>(`${path}/${what}`, { method: "POST", body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) {
      setError(r.data?.message ?? errorText(r.data));
      return null;
    }
    return r.data;
  }
  const plan = async (workspaceId?: string) => {
    const r = await post("approve", workspaceId ? { workspaceId } : {});
    if (r?.href) router.push(r.href);
  };
  const dismiss = async () => {
    if (await post("dismiss")) setGone(true);
  };

  if (gone) {
    return (
      <li role="status" className="px-4 py-1 text-xs text-shell-muted">
        Dismissed. It won&apos;t come back for 30 days.
      </li>
    );
  }
  return <SignalRowView item={item} programmes={programmes} programmeWord={programmeWord} busy={busy} error={error} onPlan={(id) => void plan(id)} onDismiss={() => void dismiss()} />;
}

/** The row as drawn for a busy state: no state of its own. */
export function SignalRowView({
  item,
  programmes,
  programmeWord,
  busy,
  error,
  onPlan,
  onDismiss,
}: {
  item: RowItem;
  programmes: Array<{ id: string; name: string }>;
  programmeWord: string;
  busy: SignalBusy;
  error: string | null;
  onPlan: (workspaceId?: string) => void;
  onDismiss: () => void;
}) {
  const buttons = signalButtons(busy);
  const lines = item.details?.length ? item.details : [item.detail];
  return (
    <li className="flex items-center gap-3 rounded-lg border border-shell-line bg-shell-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {lines.map((line) => (
          <p key={line} className="text-xs text-shell-muted text-pretty">
            {line}
          </p>
        ))}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
      <button type="button" disabled={buttons.dismiss.disabled} onClick={onDismiss} className={GHOST}>
        {buttons.dismiss.label}
      </button>
      {programmes.length > 1 ? (
        <details className="relative shrink-0">
          <summary aria-disabled={buttons.plan.disabled || undefined} className={`cursor-pointer list-none ${ACT} ${buttons.plan.disabled ? "pointer-events-none opacity-50" : ""}`}>
            {buttons.plan.label}
          </summary>
          <div className="absolute right-0 z-10 mt-1 min-w-[12rem] rounded-md border border-shell-line bg-shell-card p-1 shadow-md">
            <div className="px-2 py-1 text-[11px] text-shell-muted">In which {programmeWord}?</div>
            {programmes.map((p) => (
              <button key={p.id} type="button" disabled={buttons.plan.disabled} onClick={() => onPlan(p.id)} className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-shell-hover disabled:opacity-50">
                {p.name}
              </button>
            ))}
          </div>
        </details>
      ) : (
        <button type="button" disabled={buttons.plan.disabled} onClick={() => onPlan(programmes[0]?.id)} className={ACT}>
          {buttons.plan.label}
        </button>
      )}
    </li>
  );
}
