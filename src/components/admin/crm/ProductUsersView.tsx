"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AudienceProductUser } from "@/lib/audience/productUsers";

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(min)) return "—";
  if (min < 60) return `${Math.max(min, 0)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

/**
 * Audience → Product users (nav v2 phase 3): people using your connected
 * products, newest first. Each product's own Users tab has everyone and the
 * per-step detail; this is the cross-product view.
 */
export function ProductUsersView() {
  const [rows, setRows] = useState<AudienceProductUser[] | null>(null);
  const [limit, setLimit] = useState(100);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/audience/product-users")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { users: AudienceProductUser[]; limit: number }) => {
        if (!alive) return;
        setRows(data.users);
        setLimit(data.limit);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-sm text-red-700 dark:text-red-400">Couldn&rsquo;t load product users — please try again.</p>;
  if (!rows) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!rows.length) {
    return (
      <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
        No product users yet. They appear when a{" "}
        <Link href="/admin/products" className="underline underline-offset-2">
          connected product
        </Link>{" "}
        sends its first sign-up.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Onboarding</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {rows.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">
                  <span className="block font-medium">{u.name ?? u.email ?? "Unnamed user"}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                    {u.name && u.email ? u.email : null}
                    {u.onWaitlist ? (
                      <span className="rounded-full bg-sky-100 px-1.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                        On your waitlist
                      </span>
                    ) : null}
                    {u.invited ? (
                      <span className="rounded-full bg-green-100 px-1.5 text-[11px] font-medium text-green-800 dark:bg-green-950 dark:text-green-300">
                        Invited
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Link href={`/admin/products/${u.connectionId}?tab=users`} className="hover:underline">
                    {u.product}
                  </Link>
                </td>
                <td className="px-3 py-2 tabular-nums">{u.stepsTotal ? `${u.stepsDone} of ${u.stepsTotal}` : "—"}</td>
                <td className="px-3 py-2 text-neutral-500">{ago(u.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length >= limit ? (
        <p className="text-xs text-neutral-500">
          Showing the {limit} most recently seen. Each product&rsquo;s Users tab lists everyone.
        </p>
      ) : null}
    </div>
  );
}
