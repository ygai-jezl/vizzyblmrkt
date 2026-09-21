"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText, timeAgo, type ProductUser, type PublicConnection } from "./api";
import { Badge, Banner, Button } from "./ui";

/** The product's end users, as built from the events it sent. */
export function UsersTable({ connection, canEdit }: { connection: PublicConnection; canEdit: boolean }) {
  const [users, setUsers] = useState<ProductUser[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const steps = [...connection.catalog.onboardingSteps].sort((a, b) => a.order - b.order);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      const q = after ? `?after=${encodeURIComponent(after)}` : "";
      const r = await api<{ users: ProductUser[]; next: string | null }>(
        `/api/admin/connections/${connection.id}/users${q}`,
      );
      setLoading(false);
      if (!r.ok) return setError(errorText(r.data));
      setError(null);
      setUsers((cur) => (after ? [...cur, ...r.data.users] : r.data.users));
      setNext(r.data.next);
    },
    [connection.id],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function erase(u: ProductUser) {
    if (!window.confirm(`Erase ${u.email ?? u.externalUserId}? Their profile and event history are deleted.`)) return;
    const r = await api(`/api/admin/connections/${connection.id}/users/${u.id}`, { method: "DELETE" });
    if (!r.ok) return setError(errorText(r.data));
    await load(null);
  }

  return (
    <div className="space-y-3">
      {error ? <Banner tone="err">{error}</Banner> : null}
      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Onboarding</th>
              <th className="px-3 py-2 font-medium">Consent</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-neutral-500">
                  No users yet — they appear when your product sends an identify or track event.
                </td>
              </tr>
            ) : null}
            {users.map((u) => (
              <tr key={u.id} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="px-3 py-2">
                  <div className="font-medium">
                    {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "—"}
                  </div>
                  <div className="font-mono text-neutral-500">{u.email ? `${u.email} · ` : ""}{u.externalUserId}</div>
                </td>
                <td className="px-3 py-2">
                  {u.status === "deleted" ? (
                    <Badge tone="red">erased</Badge>
                  ) : (
                    <span title={steps.map((s) => `${u.steps[s.id] ? "✓" : "☐"} ${s.label}`).join("\n")}>
                      {steps.map((s) => (u.steps[s.id] ? "✓" : "☐")).join(" ")}{" "}
                      <span className="text-neutral-500">
                        {steps.filter((s) => u.steps[s.id]).length}/{steps.length}
                      </span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{u.consent ? <Badge>{u.consent.basis}</Badge> : <span className="text-neutral-400">—</span>}</td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{timeAgo(u.lastSeenAt)}</td>
                <td className="px-3 py-2 text-right">
                  {canEdit && u.status !== "deleted" ? (
                    <Button tone="danger" onClick={() => void erase(u)}>
                      Erase
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next ? (
        <Button disabled={loading} onClick={() => void load(next)}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
