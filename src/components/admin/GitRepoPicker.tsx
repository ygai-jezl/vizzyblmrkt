"use client";

import { useEffect, useMemo, useState } from "react";

interface Repo {
  fullPath: string;
  owner: string;
  ownerKind: "user" | "org" | "group";
  name: string;
  private: boolean;
  webUrl: string;
}

interface Listing {
  repos: Repo[];
  truncated: boolean;
  selected: string[] | null;
  maxSelected: number;
  orgAccessUrl: string | null;
}

const ERRORS: Record<string, string> = {
  reconnect_required: "This connection can't list repositories — disconnect and connect again.",
  provider_error: "The provider didn't respond. Try again in a moment.",
  not_connected: "Not connected.",
  unknown_repos: "Some repositories are no longer accessible — reload and pick again.",
};

/**
 * Choose which repos a GitHub/GitLab connection may be used for, grouped by the
 * personal account and each org/group the connected user belongs to. Only the
 * selected repos can be ingested privately.
 */
export function GitRepoPicker({
  provider,
  label,
  onSaved,
  onClose,
}: {
  provider: "github" | "gitlab";
  label: string;
  onSaved: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`/api/admin/integrations/${provider}/repos`).catch(() => null);
      const d = (await res?.json().catch(() => ({}))) as Partial<Listing> & { error?: string };
      if (!live) return;
      if (!res?.ok || !d.repos) {
        setError(ERRORS[d?.error ?? ""] ?? "Couldn't load repositories.");
        return;
      }
      setData(d as Listing);
      setPicked(new Set(d.selected ?? []));
    })();
    return () => {
      live = false;
    };
  }, [provider]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const m = new Map<string, Repo[]>();
    for (const r of data?.repos ?? []) {
      if (q && !r.fullPath.includes(q)) continue;
      const list = m.get(r.owner) ?? [];
      list.push(r);
      m.set(r.owner, list);
    }
    return [...m.entries()];
  }, [data, filter]);

  function toggle(path: string) {
    const next = new Set(picked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setPicked(next);
  }

  function setOwner(repos: Repo[], on: boolean) {
    const next = new Set(picked);
    for (const r of repos) {
      if (on) next.add(r.fullPath);
      else next.delete(r.fullPath);
    }
    setPicked(next);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/integrations/${provider}/repos`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: [...picked] }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(ERRORS[d.error ?? ""] ?? "Couldn't save the selection.");
        return;
      }
      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const over = data ? picked.size > data.maxSelected : false;

  return (
    <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Choose {label} repositories</div>
        <span className="text-xs text-neutral-500">
          {picked.size} selected{data ? ` of ${data.repos.length}` : ""}
        </span>
      </div>
      <p className="text-xs text-neutral-500">
        Only the repositories you select here can be ingested with this connection. Repos from
        your personal account and every {provider === "github" ? "organization" : "group"} you
        belong to are listed.
      </p>

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {!data && !error ? <p className="text-xs text-neutral-400">Loading repositories…</p> : null}

      {data ? (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by owner or name"
            className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {groups.length === 0 ? (
              <p className="text-xs text-neutral-400">No repositories match.</p>
            ) : null}
            {groups.map(([owner, repos]) => {
              const all = repos.every((r) => picked.has(r.fullPath));
              const kind = repos[0]?.ownerKind === "user" ? "personal" : provider === "github" ? "org" : "group";
              return (
                <div key={owner} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">
                      {owner} <span className="font-normal text-neutral-400">· {kind}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setOwner(repos, !all)}
                      className="text-xs text-violet-600 underline dark:text-violet-400"
                    >
                      {all ? "Clear" : "Select all"}
                    </button>
                  </div>
                  {repos.map((r) => (
                    <label key={r.fullPath} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={picked.has(r.fullPath)}
                        onChange={() => toggle(r.fullPath)}
                      />
                      <span className="truncate">{r.fullPath.slice(owner.length + 1) || r.name}</span>
                      {r.private ? (
                        <span className="rounded bg-neutral-200 px-1.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          private
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          {data.truncated ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Only the first {data.repos.length} repositories are shown.
            </p>
          ) : null}
          {data.orgAccessUrl ? (
            <p className="text-xs text-neutral-500">
              Missing an organization?{" "}
              <a href={data.orgAccessUrl} target="_blank" rel="noreferrer" className="underline">
                Grant or request access for it on GitHub
              </a>
              , then reopen this list.
            </p>
          ) : null}
          {over ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Select at most {data.maxSelected} repositories.
            </p>
          ) : null}
        </>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!data || saving || over}
          className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900"
        >
          {saving ? "Saving…" : "Save selection"}
        </button>
      </div>
    </div>
  );
}
