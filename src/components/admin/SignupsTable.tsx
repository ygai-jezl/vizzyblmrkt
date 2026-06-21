"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface AdminSignupRow {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  amountReferred: number;
  /** 1-based queue position; only set in a per-launch view, null when unranked. */
  rank?: number;
  createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  verified_active: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  unverified: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  offboarded: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

/**
 * Admin signups table. `mode` switches between the Active list (offboard / delete
 * + per-launch move) and the Offboarded directory (delete only — PRD §4.2). Move
 * controls need a single selection and a `campaignId` (rank is per-campaign).
 */
export function SignupsTable({
  initialRows,
  mode = "active",
  campaignId,
}: {
  initialRows: AdminSignupRow[];
  mode?: "active" | "offboarded";
  campaignId?: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [positions, setPositions] = useState(10);

  const rows = initialRows;
  const showRank = !!campaignId;
  const canMove = mode === "active" && !!campaignId;
  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function run(action: "offboard" | "delete") {
    if (selected.size === 0) return;
    if (
      action === "delete" &&
      !window.confirm(`Permanently delete ${selected.size} signup(s)? This cannot be undone.`)
    ) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/admin/signups/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ids: [...selected] }),
    });
    setBusy(false);
    if (!res.ok) {
      window.alert("Action failed. Please try again.");
      return;
    }
    setSelected(new Set());
    router.refresh();
  }

  async function move(action: "move_to_top" | "move_up") {
    if (selected.size !== 1 || !campaignId) return;
    const id = [...selected][0]!;
    setBusy(true);
    const res = await fetch("/api/admin/signups/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        id,
        campaignId,
        ...(action === "move_up" ? { positions } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      window.alert(
        res.status === 409
          ? "Only verified, active signups can be moved."
          : "Move failed. Please try again.",
      );
      return;
    }
    setSelected(new Set());
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        {mode === "offboarded" ? "No offboarded signups." : "No signups yet."}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-medium">{selected.size} selected</span>

          {canMove && selected.size === 1 ? (
            <>
              <button
                disabled={busy}
                onClick={() => move("move_to_top")}
                className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-white disabled:opacity-60 dark:border-neutral-700"
              >
                Move to top
              </button>
              <span className="inline-flex items-center gap-1">
                <button
                  disabled={busy}
                  onClick={() => move("move_up")}
                  className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-white disabled:opacity-60 dark:border-neutral-700"
                >
                  Move up
                </button>
                <input
                  type="number"
                  min={1}
                  value={positions}
                  onChange={(e) => setPositions(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  aria-label="positions to move up"
                />
                <span className="text-neutral-500">spots</span>
              </span>
            </>
          ) : null}

          {mode === "active" ? (
            <button
              disabled={busy}
              onClick={() => run("offboard")}
              className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-white disabled:opacity-60 dark:border-neutral-700"
            >
              Offboard
            </button>
          ) : null}
          <button
            disabled={busy}
            onClick={() => run("delete")}
            className="rounded-md border border-red-300 px-3 py-1 text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400"
          >
            Delete
          </button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              {showRank ? <th className="px-3 py-2 text-right font-medium">Rank</th> : null}
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Referrals</th>
              <th className="px-3 py-2 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.email ?? r.id}`}
                  />
                </td>
                {showRank ? (
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                    {r.rank != null ? `#${r.rank}` : "—"}
                  </td>
                ) : null}
                <td className="px-3 py-2">{r.email ?? "—"}</td>
                <td className="px-3 py-2">
                  {[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[r.status] ?? "bg-neutral-100 text-neutral-600"
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.amountReferred}</td>
                <td className="px-3 py-2 tabular-nums text-neutral-500">
                  {r.createdAt.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
