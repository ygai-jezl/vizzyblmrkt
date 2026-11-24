"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/components/admin/connect/api";
import type { ReviewItem } from "@/lib/review/summary";

/**
 * Review: a suggestion from collected numbers (CONNECTOR_SIGNALS_ENABLED), modelled on
 * MarkSeenButton. Plan an article opens Create with the question, page or search filled in (in the
 * programme chosen, when there are several); Dismiss takes the row away and says it stays away 30
 * days. Admins only: the page draws it only for them.
 */

const GHOST = "rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50";
const ACT = "shrink-0 rounded-md border border-shell-line px-3 py-1.5 text-sm font-medium hover:bg-shell-hover disabled:opacity-50";

type Answer = { ok?: boolean; href?: string; message?: string };

export function SignalRow({ item, programmes, programmeWord }: { item: ReviewItem & { signal: { id: string } }; programmes: Array<{ id: string; name: string }>; programmeWord: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const path = `/api/admin/data-signals/${encodeURIComponent(item.signal.id)}`;

  async function post(what: "approve" | "dismiss", body: Record<string, unknown> = {}): Promise<Answer | null> {
    setBusy(true);
    setError(null);
    const r = await api<Answer>(`${path}/${what}`, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
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
      <button type="button" disabled={busy} onClick={() => void dismiss()} className={GHOST}>
        Dismiss
      </button>
      {programmes.length > 1 ? (
        <details className="relative shrink-0">
          <summary className={`cursor-pointer list-none ${ACT}`}>Plan an article</summary>
          <div className="absolute right-0 z-10 mt-1 min-w-[12rem] rounded-md border border-shell-line bg-shell-card p-1 shadow-md">
            <div className="px-2 py-1 text-[11px] text-shell-muted">In which {programmeWord}?</div>
            {programmes.map((p) => (
              <button key={p.id} type="button" disabled={busy} onClick={() => void plan(p.id)} className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-shell-hover">
                {p.name}
              </button>
            ))}
          </div>
        </details>
      ) : (
        <button type="button" disabled={busy} onClick={() => void plan(programmes[0]?.id)} className={ACT}>
          {busy ? "Planning…" : "Plan an article"}
        </button>
      )}
    </li>
  );
}
