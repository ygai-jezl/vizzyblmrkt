"use client";

import { useRef, useState } from "react";

/**
 * "Add exit" toolbar control for the Journey Canvas. Opens a popover that lazily
 * loads the tenant's Content-OS email sequences (GET /api/admin/email-sequences)
 * and lets the operator drop a terminal exit node that either just ends the
 * journey or hands the recipient off into a chosen sequence. Empty states match
 * the spec: no sequences yet (but a workspace exists) → create-a-sequence link;
 * no workspace at all → create-a-workspace link. Both save the journey first
 * (handled by the parent) before navigating away.
 */
type Seq = {
  planId: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  sequenceType: string | null;
  status: string;
};
type Data = { hasWorkspace: boolean; firstWorkspaceId: string | null; sequences: Seq[] };

export type ExitTarget =
  | {
      exitTargetKind: "sequence";
      exitTargetPlanId: string;
      exitTargetWorkspaceId: string;
      exitTargetLabel: string;
    }
  | { exitTargetKind: "weekly"; exitTargetLabel: string };

const BTN =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900";
const ROW =
  "block w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900";
const LINK =
  "block w-full rounded px-2 py-2 text-left text-xs text-sky-700 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950/40";

export function AddExitControl({
  onAddExit,
  onCreateSequence,
  onCreateWorkspace,
}: {
  onAddExit: (target?: ExitTarget) => void;
  onCreateSequence: (workspaceId: string) => void | Promise<void>;
  onCreateWorkspace: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  // Generation counter so a slow, stale fetch (e.g. from an earlier open that
  // failed) can't clobber the state of a newer one after it resolves.
  const reqIdRef = useRef(0);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(false);
    const my = ++reqIdRef.current;
    try {
      const res = await fetch("/api/admin/email-sequences");
      if (!res.ok) throw new Error("failed");
      const d = (await res.json()) as Data;
      if (my === reqIdRef.current) setData(d);
    } catch {
      if (my === reqIdRef.current) setError(true);
    } finally {
      if (my === reqIdRef.current) setLoading(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        className={BTN}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        ⇥ Add exit
      </button>

      {open ? (
        <>
          {/* Click-away backdrop. */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute left-0 top-full z-40 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          >
            <button
              type="button"
              onClick={() => {
                onAddExit();
                setOpen(false);
              }}
              className={ROW}
            >
              ⇥ End journey (no handoff)
            </button>
            <button
              type="button"
              onClick={() => {
                onAddExit({ exitTargetKind: "weekly", exitTargetLabel: "Weekly newsletter" });
                setOpen(false);
              }}
              className={ROW}
            >
              📰 Subscribe to the weekly newsletter
            </button>

            <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
              Hand off into a sequence
            </div>

            {loading ? (
              <div className="px-2 py-2 text-xs text-neutral-500">Loading sequences…</div>
            ) : error ? (
              <div className="px-2 py-2 text-xs text-red-600 dark:text-red-400">
                Couldn&apos;t load sequences. Close and try again.
              </div>
            ) : data && data.sequences.length > 0 ? (
              <div className="max-h-64 overflow-y-auto">
                {data.sequences.map((s) => (
                  <button
                    key={s.planId}
                    type="button"
                    onClick={() => {
                      onAddExit({
                        exitTargetKind: "sequence",
                        exitTargetPlanId: s.planId,
                        exitTargetWorkspaceId: s.workspaceId,
                        exitTargetLabel: s.name,
                      });
                      setOpen(false);
                    }}
                    className={ROW}
                  >
                    <div className="truncate font-medium">{s.name}</div>
                    <div className="truncate text-[10px] text-neutral-500">
                      {s.workspaceName}
                      {s.sequenceType ? ` · ${s.sequenceType.replace(/_/g, " ")}` : ""}
                      {s.status ? ` · ${s.status}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            ) : data && data.hasWorkspace && data.firstWorkspaceId ? (
              <button
                type="button"
                onClick={() => {
                  void onCreateSequence(data.firstWorkspaceId!);
                  setOpen(false);
                }}
                className={LINK}
              >
                No sequences yet —{" "}
                <span className="underline">click here to create a sequence</span>. We&apos;ll
                save this journey first.
              </button>
            ) : data ? (
              <button
                type="button"
                onClick={() => {
                  void onCreateWorkspace();
                  setOpen(false);
                }}
                className={LINK}
              >
                <span className="underline">Click here to create a workspace</span>, then create
                an Email sequence. We&apos;ll save this journey first.
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
