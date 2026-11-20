"use client";

import { useCallback, useEffect, useState } from "react";

interface Status {
  label: string;
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  repoSelection?: boolean;
  selectedRepos?: { fullPath: string; webUrl: string }[] | null;
}

/** id of the <datalist> of selected repo URLs this hint renders (for the URL input). */
export function gitRepoDatalistId(provider: "github" | "gitlab"): string {
  return `git-repos-${provider}`;
}

/** Inline hint in the ingest bar: shows whether the provider is connected and, for an
 *  admin, a "Connect" link (popup) when it isn't; a member is asked to get an admin to
 *  connect it. With repo selection on, it also says how many repos are selected and offers
 *  them as URL suggestions (a <datalist>). Renders nothing if the OAuth app isn't
 *  configured in this env (public repos still work without it). */
export function GitConnectHint({ provider }: { provider: "github" | "gitlab" }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [canEdit, setCanEdit] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/integrations");
      if (!r.ok) return;
      const d = (await r.json().catch(() => ({}))) as {
        providers?: Record<string, Status>;
        canEdit?: boolean;
      };
      setStatus(d.providers?.[provider] ?? null);
      setCanEdit(d.canEdit === true);
    } catch {
      /* ignore */
    }
  }, [provider]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const f = () => load();
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [load]);

  if (!status || !status.configured) return null;
  const label = status.label || provider;
  if (status.connected) {
    const repos = status.repoSelection ? status.selectedRepos : null;
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        ✓ {label} connected{status.accountLogin ? ` (${status.accountLogin})` : ""}
        {repos ? (
          repos.length ? (
            <span className="text-neutral-500"> · {repos.length} selected repos</span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              {" "}
              · no repos selected
              {canEdit ? (
                <>
                  :{" "}
                  <a href="/admin/account/connections" className="underline">
                    choose repositories
                  </a>{" "}
                  to ingest private ones
                </>
              ) : null}
            </span>
          )
        ) : null}
        {repos?.length ? (
          <datalist id={gitRepoDatalistId(provider)}>
            {repos.map((r) => (
              <option key={r.fullPath} value={r.webUrl} />
            ))}
          </datalist>
        ) : null}
      </span>
    );
  }
  if (!canEdit) {
    return (
      <span className="text-xs text-neutral-500">
        {label} isn&apos;t connected. Ask an admin to connect it for private repos.
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() =>
        window.open(`/api/admin/integrations/${provider}/start`, "git-oauth", "width=920,height=820")
      }
      className="text-xs text-violet-600 underline dark:text-violet-400"
    >
      Connect {label} to ingest private repos
    </button>
  );
}
