"use client";

import { useEffect, useRef, useState } from "react";
import type { VersionListing } from "@/lib/content/blog/versions";
import type { VersionReason } from "@/lib/types/articleRefresh";

/**
 * A blog article's earlier versions (BLOG_REFRESH_ENABLED), in the hub panel under Freshness: one
 * is kept each time Apply, Regenerate or Restore replaces the copy, the last 10. Restore asks once,
 * in the row, never in a browser dialog. /help/write-and-schedule#versions explains it.
 */

export const NO_VERSIONS = "No earlier versions yet. YouGrow keeps one each time Apply, Regenerate or Restore replaces the copy.";
export const RESTORED_SAID = (n: number) => `Version ${n} is back. The copy it replaced is kept as a version. Approve the article again when it reads right.`;
export const RESTORE_KEEPS = "Restore keeps the live mark and Published. The article goes back to you to approve.";

const BEFORE: Record<VersionReason, string> = { apply: "before Apply", regenerate: "before Regenerate", restore: "before Restore" };

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export interface VersionsControls {
  list: (nodeId: string) => Promise<VersionListing[] | null>;
  /** Resolves to a line saying what went wrong, or null. */
  restore: (nodeId: string, n: number) => Promise<string | null>;
}

export function VersionsCard({ nodeId, controls, stamp, disabled = false }: { nodeId: string; controls: VersionsControls; stamp: string; disabled?: boolean }) {
  const [versions, setVersions] = useState<VersionListing[] | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  // The canvas makes its handlers afresh each render: read the latest without reading again.
  const latest = useRef(controls);
  latest.current = controls;

  // Read again when the copy changes underneath (a rewrite keeps a version).
  useEffect(() => {
    let gone = false;
    void latest.current.list(nodeId).then((v) => {
      if (!gone) setVersions(v);
    });
    return () => {
      gone = true;
    };
  }, [nodeId, stamp]);

  if (versions === null) return null;

  async function restore(n: number) {
    setBusy(true);
    setSaid(null);
    const failed = await controls.restore(nodeId, n).catch(() => "That didn't restore. Try again in a moment.");
    setBusy(false);
    setAsking(null);
    setSaid(failed ? { text: failed, error: true } : { text: RESTORED_SAID(n), error: false });
    if (!failed) setVersions(await controls.list(nodeId));
  }

  return (
    <section id="versions" aria-labelledby="versions-h" className="space-y-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
      <h3 id="versions-h" className="text-xs font-semibold">
        Versions
      </h3>
      {versions.length ? (
        <>
          <ul className="space-y-1">
            {versions.map((v) => (
              <li key={v.n} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-neutral-700 dark:text-neutral-300">
                  Version {v.n} · {when(v.at)} · {BEFORE[v.reason]} · {v.words} words
                </span>
                {asking === v.n ? (
                  <span className="flex items-center gap-2">
                    <span className="text-neutral-600 dark:text-neutral-300">Put it back?</span>
                    <button
                      type="button"
                      onClick={() => void restore(v.n)}
                      disabled={disabled || busy}
                      className="rounded-md bg-neutral-900 px-2 py-0.5 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      {busy ? "Restoring…" : "Restore"}
                    </button>
                    <button type="button" onClick={() => setAsking(null)} disabled={busy} className="underline disabled:opacity-50">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAsking(v.n)}
                    disabled={disabled || busy}
                    className="rounded-md border border-neutral-300 px-2 py-0.5 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-neutral-500 dark:text-neutral-400">{RESTORE_KEEPS}</p>
        </>
      ) : (
        <p className="text-neutral-500 dark:text-neutral-400">{NO_VERSIONS}</p>
      )}
      {said ? (
        <p role={said.error ? "alert" : "status"} className={said.error ? "text-red-700 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}>
          {said.text}
        </p>
      ) : null}
    </section>
  );
}
