"use client";

import { useCallback, useState } from "react";
import type { Company } from "@/lib/types/company";
import { CompanyDetail } from "./CompanyDetail";

const STATUS_STYLES: Record<string, string> = {
  enriched: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  processing: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  manual: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

export function CompaniesView({
  isAdmin,
  initialRows,
  initialCursor,
}: {
  isAdmin: boolean;
  initialRows: Company[];
  initialCursor: string | null;
}) {
  const [rows, setRows] = useState<Company[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (opts: { reset: boolean; q: string; cursor: string | null }) => {
    setLoading(true);
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (!opts.reset && opts.cursor) p.set("cursor", opts.cursor);
    try {
      const res = await fetch(`/api/admin/crm/companies?${p.toString()}`);
      const data = (await res.json()) as { companies: Company[]; nextCursor: string | null };
      setRows((prev) => (opts.reset ? data.companies : [...prev, ...data.companies]));
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load({ reset: true, q, cursor: null });
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company or domain…"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
        />
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No companies yet. They appear as corporate-domain contacts get enriched.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Industry</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 text-right font-medium">Contacts</th>
                <th className="px-3 py-2 font-medium">Enrichment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className="cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
                >
                  <td className="px-3 py-2 font-medium">{c.name ?? c.domain}</td>
                  <td className="px-3 py-2 text-neutral-500">{c.domain}</td>
                  <td className="px-3 py-2 text-neutral-500">{c.profile?.industry ?? "—"}</td>
                  <td className="px-3 py-2 text-neutral-500">{c.profile?.employeeRange ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.contactCount}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[c.enrichmentStatus] ?? "bg-neutral-100 text-neutral-600"
                      }`}
                    >
                      {c.enrichmentStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor ? (
        <button
          disabled={loading}
          onClick={() => load({ reset: false, q, cursor })}
          className="w-full rounded-md border border-neutral-300 py-2 text-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}

      {selected ? (
        <CompanyDetail companyId={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
