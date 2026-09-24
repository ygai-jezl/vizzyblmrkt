"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GitRepoPicker } from "./GitRepoPicker";
import { GitHubAccountChooser, type ChooseResult } from "./connect/GitHubAccountChooser";

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
  if (r.length === 0) return "No repositories selected yet — choose which to use.";
  const shown = r.slice(0, 3).map((x) => x.fullPath).join(", ");
  return `${r.length} repositor${r.length === 1 ? "y" : "ies"}: ${shown}${r.length > 3 ? ", …" : ""}`;
}

const PROVIDER_IDS = ["github", "gitlab", "x", "linkedin", "linkedin_org"] as const;

/** Why a connection attempt failed, in plain words. */
const CONNECT_ERRORS: Record<string, string> = {
  installation_not_yours: "That GitHub installation isn't one your account can access. Install the app from here, signed in as a member of that account.",
  app_not_read_only: "That GitHub installation has more than read access, so we refused it. Reinstall the YouGrow app from here.",
  no_installation: "GitHub didn't finish installing the app. Try Connect again, and choose where to install it.",
  token_exchange_failed: "GitHub didn't confirm the connection. Please try again.",
  bad_state: "That connection attempt expired or came from another session. Please start again from here.",
  state_expired: "That connection attempt expired. Please start again from here.",
  access_denied: "The connection was cancelled on GitHub.",
  missing_code: "You were sent back before the connection finished. Press Connect again to finish.",
  installations_lookup_failed: "We couldn't check where the YouGrow app is installed on GitHub. Please try again.",
  choice_expired: "That choice expired. Press Connect GitHub to start again.",
  not_a_choice: "That GitHub account wasn't one of the choices. Press Connect GitHub to start again.",
  exception: "Something went wrong while connecting. Please try again.",
};

/** Manage per-tenant GitHub/GitLab OAuth connections (for ingesting private repos). */
export function ConnectionsPanel() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [providers, setProviders] = useState<Record<string, ProviderStatus> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  // "Which GitHub account?" finished: show the result in the usual banner.
  const chosen = useCallback(
    (r: ChooseResult | null) => {
      const q = !r
        ? ""
        : r.ok
          ? "?status=ok&provider=github"
          : `?status=error&reason=${encodeURIComponent(r.reason)}&provider=github`;
      router.replace(`${pathname}${q}`);
      void load();
    },
    [router, pathname, load],
  );
  const chooseToken = sp.get("choose") === "github" ? sp.get("c") : null;

  async function disconnect(p: string) {
    const label = providers?.[p]?.label ?? p;
    if (!window.confirm(`Disconnect ${label}?`)) return;
    setBusy(p);
    try {
      await fetch(`/api/admin/integrations/${p}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const status = sp.get("status");
  const bannerProvider = sp.get("provider") ?? "";
  const bannerLabel = providers?.[bannerProvider]?.label ?? bannerProvider;
  const reason = sp.get("reason") ?? "error";
  const banner =
    status === "ok"
      ? { tone: "ok", msg: sp.get("updated") ? `Your ${bannerLabel} repositories were updated.` : `Connected ${bannerLabel}.` }
      : status === "requested"
        ? {
            tone: "ok",
            msg: "Request sent — GitHub has asked your organisation's owners to approve the YouGrow app. Once they do, connect again here to finish.",
          }
        : status === "error"
          ? { tone: "err", msg: CONNECT_ERRORS[reason] ?? `Couldn't connect (${reason}).` }
          : null;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Connections</h2>
        <p className="text-sm text-neutral-500">
          Connect GitHub or GitLab so we can read your private repositories — for your knowledge base, and to learn
          how your product works. We only ever read your code; we never change it. Connect X or
          LinkedIn so Distribute can publish scheduled posts on your behalf. Any tokens are stored
          encrypted, never in plaintext.
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

      {chooseToken ? <GitHubAccountChooser token={chooseToken} onDone={chosen} /> : null}

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
                    <span className="text-xs text-neutral-400">
                      OAuth app not configured in this environment.
                    </span>
                  ) : s.connected ? (
                    <span className="text-xs text-green-600 dark:text-green-400">
                      Connected{s.accountLogin ? ` as ${s.accountLogin}` : ""}.
                      {s.readOnly ? <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-300">Read-only</span> : null}
                    {s.manageUrl && !s.upgradeAvailable ? (
                      <a className="ml-2 text-neutral-500 underline" href={s.manageUrl} target="_blank" rel="noreferrer">
                        Add or remove repositories on GitHub
                      </a>
                    ) : null}
                      {s.upgradeAvailable ? (
                        <span className="mt-1 block text-amber-700 dark:text-amber-400">
                          This older connection can also write to your repos. Switch to read-only access — we only ever read your code.{" "}
                          <button type="button" className="underline" onClick={() => connect(p)}>
                            Switch now
                          </button>
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-500">Not connected.</span>
                  )}
                  {s?.connected && s.repoSelection ? (
                    <div className="text-xs text-neutral-500">
                      {repoSummary(s)}{" "}
                      <button
                        type="button"
                        onClick={() => setPicking(picking === p ? null : p)}
                        className="text-violet-600 underline dark:text-violet-400"
                      >
                        {s.selectedRepos?.length ? "Manage" : "Choose repositories"}
                      </button>
                    </div>
                  ) : null}
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
                      {s.appInstall ? "Connect GitHub (read-only)" : "Connect"}
                    </button>
                  )
                ) : null}
              </div>
              {picking === p && s?.connected && s.repoSelection && GIT_IDS.has(p) ? (
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
