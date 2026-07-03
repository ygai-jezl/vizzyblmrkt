"use client";

import { useCallback, useState } from "react";
import type { EngagedContact } from "@/lib/types/engagedContact";

/** Profile URL for a handle, per platform (X only today). */
function profileUrl(platform: string, handle?: string | null): string | null {
  if (!handle) return null;
  if (platform === "x") return `https://x.com/${handle}`;
  if (platform === "instagram") return `https://instagram.com/${handle}`;
  if (platform === "linkedin") return `https://linkedin.com/in/${handle}`;
  return null;
}

const num = (n?: number | null) => (typeof n === "number" ? n.toLocaleString() : "—");

export function EngagedView({
  isAdmin,
  initialRows,
  initialCursor,
}: {
  isAdmin: boolean;
  initialRows: EngagedContact[];
  initialCursor: string | null;
}) {
  const [rows, setRows] = useState<EngagedContact[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (opts: { reset: boolean; cursor: string | null }) => {
    setLoading(true);
    const p = new URLSearchParams();
    if (!opts.reset && opts.cursor) p.set("cursor", opts.cursor);
    try {
      const res = await fetch(`/api/admin/crm/engaged?${p.toString()}`);
      const data = (await res.json()) as { contacts: EngagedContact[]; nextCursor: string | null };
      setRows((prev) => (opts.reset ? data.contacts : [...prev, ...data.contacts]));
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, []);

  async function remove(id: string) {
    if (!confirm("Remove this engaged contact?")) return;
    const res = await fetch(`/api/admin/crm/engaged/${id}`, { method: "DELETE" });
    if (res.ok) setRows((prev) => prev.filter((r) => r.id !== id));
  }

  // Client-side search over handle/name (the API returns the whole engaged list).
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? rows.filter(
        (r) => r.handle?.toLowerCase().includes(needle) || r.name?.toLowerCase().includes(needle),
      )
    : rows;

  return (
    <div className="space-y-3">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search handle or name…"
        className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
      />

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No engaged contacts yet. People who reply, mention, quote, or DM your connected social accounts appear here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-3 py-2 font-medium">Handle</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Bio</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 text-right font-medium">Followers</th>
                <th className="px-3 py-2 text-right font-medium">Following</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {visible.map((c) => {
                const url = profileUrl(c.platform, c.handle);
                return (
                  <tr key={c.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                    <td className="px-3 py-2 font-medium">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                          @{c.handle}
                        </a>
                      ) : (
                        <span className="text-neutral-500">@{c.handle ?? c.userId}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{c.name ?? "—"}</td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-neutral-500">{c.bio ?? "—"}</td>
                    <td className="px-3 py-2 text-neutral-500">{c.location ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(c.followers)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(c.following)}</td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin ? (
                        <button
                          onClick={() => remove(c.id)}
                          className="text-xs text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                          title="Remove"
                        >
                          Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cursor ? (
        <button
          disabled={loading}
          onClick={() => load({ reset: false, cursor })}
          className="w-full rounded-md border border-neutral-300 py-2 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
