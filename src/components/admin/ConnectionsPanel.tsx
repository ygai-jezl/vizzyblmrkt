"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface ProviderStatus {
  label: string;
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  connectedAt: string | null;
}

const PROVIDER_IDS = ["github", "gitlab"] as const;

/** Manage per-tenant GitHub/GitLab OAuth connections (for ingesting private repos). */
export function ConnectionsPanel() {
  const sp = useSearchParams();
  const [providers, setProviders] = useState<Record<string, ProviderStatus> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/integrations");
      if (!res.ok) return;
      const d = (await res.json().catch(() => ({}))) as {
        providers?: Record<string, ProviderStatus>;
      };
      setProviders(d.providers ?? {});
    } catch {
      /* keep current */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Re-check when the OAuth popup closes and focus returns.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  function connect(p: string) {
    window.open(`/api/admin/integrations/${p}/start`, "git-oauth", "width=920,height=820");
  }

  async function disconnect(p: string) {
    if (!window.confirm(`Disconnect ${p}? Existing private-repo sources will stop refreshing.`)) return;
    setBusy(p);
    try {
      await fetch(`/api/admin/integrations/${p}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const status = sp.get("status");
  const banner =
    status === "ok"
      ? { tone: "ok", msg: `Connected ${sp.get("provider") ?? ""}.` }
      : status === "error"
        ? { tone: "err", msg: `Couldn't connect (${sp.get("reason") ?? "error"}).` }
        : null;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Connections</h2>
        <p className="text-sm text-neutral-500">
          Connect GitHub or GitLab so knowledge ingestion can clone your private repositories. The
          token is stored encrypted and shared across this workspace&apos;s ingests.
        </p>
      </div>

      {banner ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300"
              : "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
          }`}
        >
          {banner.msg}
        </p>
      ) : null}

      <div className="space-y-2">
        {PROVIDER_IDS.map((p) => {
          const s = providers?.[p];
          return (
            <div
              key={p}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-300 p-3 dark:border-neutral-700"
            >
              <div>
                <div className="text-sm font-medium">{s?.label ?? p}</div>
                {!s ? (
                  <span className="text-xs text-neutral-400">Loading…</span>
                ) : !s.configured ? (
                  <span className="text-xs text-neutral-400">
                    OAuth app not configured in this environment.
                  </span>
                ) : s.connected ? (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Connected{s.accountLogin ? ` as ${s.accountLogin}` : ""}.
                  </span>
                ) : (
                  <span className="text-xs text-neutral-500">Not connected.</span>
                )}
              </div>
              {s?.configured ? (
                s.connected ? (
                  <button
                    onClick={() => disconnect(p)}
                    disabled={busy === p}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
                  >
                    {busy === p ? "…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    onClick={() => connect(p)}
                    className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  >
                    Connect
                  </button>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
