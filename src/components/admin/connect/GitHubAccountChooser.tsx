"use client";

import { useEffect, useState } from "react";

interface Choice {
  installationId: number;
  accountLogin: string | null;
  accountType: "User" | "Organization" | null;
  repositorySelection: string | null;
}

export type ChooseResult = { ok: true } | { ok: false; reason: string };

function describe(c: Choice): string {
  const kind = c.accountType === "Organization" ? "Organisation" : c.accountType === "User" ? "Personal account" : "GitHub account";
  const repos = c.repositorySelection === "all" ? "all repositories" : "repositories you chose";
  return `${kind} · ${repos}`;
}

/**
 * After GitHub confirms who's connecting: the accounts where the YouGrow app is
 * already installed, to pick one — or install it on another account.
 */
export function GitHubAccountChooser({ token, onDone }: { token: string; onDone: (r: ChooseResult | null) => void }) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/admin/integrations/github/link?c=${encodeURIComponent(token)}`);
        const d = (await r.json().catch(() => ({}))) as { choices?: Choice[]; error?: string };
        if (!live) return;
        if (r.ok && Array.isArray(d.choices)) setChoices(d.choices);
        else onDone({ ok: false, reason: d.error ?? "choice_expired" });
      } catch {
        if (live) onDone({ ok: false, reason: "choice_expired" });
      }
    })();
    return () => {
      live = false;
    };
  }, [token, onDone]);

  async function use(installationId: number) {
    setBusy(installationId);
    try {
      const r = await fetch("/api/admin/integrations/github/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ c: token, installationId }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      onDone(r.ok ? { ok: true } : { ok: false, reason: d.error ?? "exception" });
    } catch {
      onDone({ ok: false, reason: "exception" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
      <div>
        <div className="text-sm font-medium">Which GitHub account should YouGrow read from?</div>
        <p className="text-xs text-neutral-500">
          The YouGrow app is already installed on these. Pick one, or install it on another account.
        </p>
      </div>
      {!choices ? (
        <span className="text-xs text-neutral-400">Loading…</span>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {choices.map((c) => (
            <li key={c.installationId} className="flex items-center justify-between gap-3 py-2">
              <div>
                <div className="text-sm">{c.accountLogin ?? `Installation ${c.installationId}`}</div>
                <div className="text-xs text-neutral-500">{describe(c)}</div>
              </div>
              <button
                type="button"
                onClick={() => use(c.installationId)}
                disabled={busy !== null}
                className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
              >
                {busy === c.installationId ? "…" : "Use this"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-4 text-xs">
        <button
          type="button"
          className="text-violet-600 underline dark:text-violet-400"
          onClick={() => window.location.assign("/api/admin/integrations/github/start?install=1")}
        >
          Install on another account
        </button>
        <button type="button" className="text-neutral-500 underline" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
