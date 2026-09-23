"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Github, Lock, ShieldCheck } from "lucide-react";
import { Banner, Button } from "./ui";

/**
 * The easiest path to "which code should we read?": connect GitHub through the
 * read-only YouGrow app right here, then tick repositories from exactly the list
 * the customer granted on GitHub — no URLs to type. Adding or removing repos is
 * one link to GitHub's own page; this list refreshes when they come back.
 */

interface Installation {
  mode: "app" | "oauth";
  connected?: boolean;
  legacy?: boolean;
  accountLogin?: string | null;
  manageUrl?: string;
  repos?: Array<{ fullName: string; url: string; defaultBranch: string | null; private: boolean }>;
  truncated?: boolean;
  error?: string;
}

function openConnect() {
  window.open("/api/admin/integrations/github/start", "git-oauth", "width=1000,height=860");
}

export function GitHubRepoChooser({
  selected,
  onChange,
  max,
  canEdit,
}: {
  selected: string[];
  onChange: (urls: string[]) => void;
  max: number;
  canEdit: boolean;
}) {
  const [info, setInfo] = useState<Installation | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/integrations/github/installation");
      if (r.ok) setInfo((await r.json()) as Installation);
    } catch {
      /* keep what we have */
    }
  }, []);

  useEffect(() => {
    void load();
    // Coming back from GitHub (install, or add/remove repos) refreshes the list.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  if (!info || info.mode !== "app") return null;

  if (!info.connected) {
    return (
      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">Connect GitHub — read-only</div>
            <p className="text-neutral-500">
              Install the YouGrow app on the repositories you choose. It can only read code; it can&apos;t change anything.
            </p>
          </div>
          {canEdit ? (
            <Button tone="primary" onClick={openConnect}>
              <Github size={14} /> Connect GitHub
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          In a GitHub organisation that isn&apos;t yours? GitHub will offer to <strong>request</strong> it from your org&apos;s owners — once they
          approve, come back and pick your repos. <a className="underline" href="/developers/connect-your-code" target="_blank" rel="noreferrer">How connecting works</a>
        </p>
      </div>
    );
  }

  if (info.legacy) {
    return (
      <Banner tone="info">
        Your GitHub connection uses an older app that can also <strong>write</strong> to your repositories. Switch to the read-only YouGrow app —
        it only takes a minute.{" "}
        {canEdit ? (
          <button type="button" className="underline" onClick={openConnect}>
            Switch to read-only
          </button>
        ) : null}
      </Banner>
    );
  }

  const repos = info.repos ?? [];
  const toggle = (url: string) =>
    onChange(selected.includes(url) ? selected.filter((u) => u !== url) : selected.length < max ? [...selected, url] : selected);

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-1.5 text-green-700 dark:text-green-400">
          <ShieldCheck size={14} /> GitHub connected, read-only{info.accountLogin ? ` — ${info.accountLogin}` : ""}
        </span>
        {info.manageUrl ? (
          <a className="inline-flex items-center gap-1 text-xs text-neutral-500 underline" href={info.manageUrl} target="_blank" rel="noreferrer">
            Add or remove repositories on GitHub <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
      {info.error === "installation_unavailable" ? (
        <Banner tone="err">
          We can&apos;t reach the YouGrow app on GitHub — it may have been uninstalled.{" "}
          {canEdit ? (
            <button type="button" className="underline" onClick={openConnect}>
              Connect again
            </button>
          ) : null}
        </Banner>
      ) : repos.length === 0 ? (
        <p className="text-sm text-neutral-500">The app can&apos;t see any repositories yet — add some on GitHub, then come back here.</p>
      ) : (
        <>
          <p className="text-xs text-neutral-500">Choose up to {max} — for example your web app and your backend.</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {repos.map((r) => (
              <li key={r.url}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canEdit || (!selected.includes(r.url) && selected.length >= max)}
                    checked={selected.includes(r.url)}
                    onChange={() => toggle(r.url)}
                  />
                  <span className="font-mono text-xs">{r.fullName}</span>
                  {r.private ? <Lock size={12} className="text-neutral-400" aria-label="private" /> : null}
                </label>
              </li>
            ))}
          </ul>
          {info.truncated ? <p className="text-xs text-neutral-500">Showing the first 500 repositories.</p> : null}
        </>
      )}
    </div>
  );
}
