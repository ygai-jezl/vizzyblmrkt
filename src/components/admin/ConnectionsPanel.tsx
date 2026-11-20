"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GitRepoPicker } from "./GitRepoPicker";
import { connectErrorMessage } from "./connectErrors";

interface ProviderStatus {
  label: string;
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  connectedAt: string | null;
  /** Git only: this connection can read but never change code. */
  readOnly?: boolean;
  /** GitHub only: a classic (read/write) connection that can switch to the read-only app. */
  upgradeAvailable?: boolean;
  /** GitHub only: connecting installs the read-only YouGrow app. */
  appInstall?: boolean;
  /** GitHub only: GitHub's page for adding or removing the app's repositories. */
  manageUrl?: string | null;
  /** Present on github/gitlab when repo selection is enabled. */
  repoSelection?: boolean;
  /** null = legacy connection (any repo). */
  selectedRepos?: { fullPath: string; webUrl: string }[] | null;
}

const GIT_IDS = new Set(["github", "gitlab"]);

function repoSummary(s: ProviderStatus): string {
  const r = s.selectedRepos;
  if (!r) return "All accessible repositories (choose to restrict).";
  if (r.length === 0) return "No repositories selected yet. Choose which to use.";
  const shown = r.slice(0, 3).map((x) => x.fullPath).join(", ");
  return `${r.length} repositor${r.length === 1 ? "y" : "ies"}: ${shown}${r.length > 3 ? ", …" : ""}`;
}

const PROVIDER_IDS = ["github", "gitlab", "x", "linkedin", "linkedin_org"] as const;

/** Names for the banner before the status has loaded. */
const LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  linkedin_org: "LinkedIn Pages",
};

/**
 * Manage the brand's GitHub, GitLab, X and LinkedIn connections. Only admins connect,
 * disconnect or choose repositories; members see what's connected, read only.
 */
export function ConnectionsPanel() {
  const sp = useSearchParams();
  const [providers, setProviders] = useState<Record<string, ProviderStatus> | null>(null);
  // From the status API: false until it says this person is an admin.
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // Which git provider's repo picker is open. Opens automatically after a fresh
  // connect (the callback adds ?select=<provider>).
  const [picking, setPicking] = useState<string | null>(() => {
    const sel = sp.get("select");
    return sel && GIT_IDS.has(sel) ? sel : null;
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/integrations");
      if (!res.ok) return;
      const d = (await res.json().catch(() => ({}))) as {
        providers?: Record<string, ProviderStatus>;
        canEdit?: boolean;
      };
      setProviders(d.providers ?? {});
      setCanEdit(d.canEdit === true);
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
    const label = providers?.[p]?.label ?? p;
    if (!window.confirm(`Disconnect ${label}?`)) return;
    setBusy(p);
    setDisconnectError(null);
    try {
      const res = await fetch(`/api/admin/integrations/${p}`, { method: "DELETE" }).catch(() => null);
      if (!res?.ok) setDisconnectError("Couldn't disconnect. Please try again.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  const status = sp.get("status");
  const bannerProvider = sp.get("provider") ?? "";
  const bannerLabel = providers?.[bannerProvider]?.label ?? LABELS[bannerProvider] ?? null;
  const reason = sp.get("reason") ?? "error";
  const banner =
    status === "ok"
      ? {
          tone: "ok",
          msg: sp.get("updated")
            ? `Your ${bannerLabel ?? "GitHub"} repositories were updated.`
            : `Connected ${bannerLabel ?? "the service"}.`,
        }
      : status === "requested"
        ? {
            tone: "ok",
            msg: "Request sent. GitHub has asked your organisation's owners to approve the YouGrow app. Once they do, connect again here to finish.",
          }
        : status === "error"
          ? { tone: "err", msg: connectErrorMessage(reason, bannerLabel) }
          : null;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Connections</h2>
        <p className="text-sm text-neutral-500">
          Connect GitHub or GitLab so we can read your private repositories, for your knowledge base and to learn
          how your product works. We only ever read your code, never change it. Connect X or
          LinkedIn so your scheduled posts publish themselves. Any tokens are stored
          encrypted, never in plaintext.
        </p>
      </div>

      {!canEdit && providers ? (
        <p className="text-sm text-neutral-500">Only admins can connect or disconnect accounts.</p>
      ) : null}

      {disconnectError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {disconnectError}
        </p>
      ) : null}

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
              className="space-y-3 rounded-md border border-neutral-300 p-3 dark:border-neutral-700"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{s?.label ?? p}</div>
                  {!s ? (
                    <span className="text-xs text-neutral-400">Loading…</span>
                  ) : !s.configured ? (
                    <span className="text-xs text-neutral-500">
                      Not set up on this YouGrow yet. Whoever runs it can add its app keys.
                    </span>
                  ) : s.connected ? (
                    <span className="text-xs text-green-600 dark:text-green-400">
                      Connected{s.accountLogin ? ` as ${s.accountLogin}` : ""}.
                      {s.readOnly ? <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-300">Read-only</span> : null}
                    {canEdit && s.manageUrl && !s.upgradeAvailable ? (
                      <a className="ml-2 text-neutral-500 underline" href={s.manageUrl} target="_blank" rel="noreferrer">
                        Add or remove repositories on GitHub
                      </a>
                    ) : null}
                      {s.upgradeAvailable ? (
                        <span className="mt-1 block text-amber-700 dark:text-amber-400">
                          This older connection can also write to your repos. Switch to read-only access, as we only ever read your code.
                          {canEdit ? (
                            <>
                              {" "}
                              <button type="button" className="underline" onClick={() => connect(p)}>
                                Switch now
                              </button>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-500">Not connected.</span>
                  )}
                  {s?.connected && s.repoSelection ? (
                    <div className="text-xs text-neutral-500">
                      {repoSummary(s)}
                      {canEdit ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            onClick={() => setPicking(picking === p ? null : p)}
                            className="text-violet-600 underline dark:text-violet-400"
                          >
                            {s.selectedRepos?.length ? "Manage" : "Choose repositories"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {canEdit && s?.configured ? (
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
                      {s.appInstall ? "Install on GitHub (read-only)" : "Connect"}
                    </button>
                  )
                ) : null}
              </div>
              {canEdit && picking === p && s?.connected && s.repoSelection && GIT_IDS.has(p) ? (
                <GitRepoPicker
                  provider={p as "github" | "gitlab"}
                  label={s.label}
                  onSaved={load}
                  onClose={() => setPicking(null)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
