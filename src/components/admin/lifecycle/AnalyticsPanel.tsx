"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "../connect/api";
import { Banner } from "../connect/ui";

/** The journey's funnel, the onboarding goal, and per-email sends + engagement. */

interface Analytics {
  enrolments: { total: number; active: number; completed: number; exited: number; stopReasons: Record<string, number> };
  items: Array<{
    poolId: string;
    itemId: string;
    label: string;
    sent: number;
    unknown: number;
    byMode: Record<string, number>;
    opens: number;
    clicks: number;
    unsubscribes: number;
    bounces: number;
    complaints: number;
  }>;
  goal: { label: string; eligible: number; reached: number; rate: number | null; medianHoursToOnboarded: number | null };
  truncated: boolean;
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub ? <div className="text-xs text-neutral-500">{sub}</div> : null}
    </div>
  );
}

export function AnalyticsPanel({ journeyId }: { journeyId: string }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await api<Analytics>(`/api/admin/lifecycle/journeys/${journeyId}/analytics`);
      if (!r.ok) setErr(errorText(r.data));
      else setData(r.data);
    })();
  }, [journeyId]);

  if (err) return <Banner tone="err">{err}</Banner>;
  if (!data) return <p className="text-sm text-neutral-500">Loading…</p>;
  const e = data.enrolments;
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Enrolled" value={e.total} />
        <Stat label="In progress" value={e.active} />
        <Stat label="Finished" value={e.completed} />
        <Stat label="Stopped early" value={e.exited} sub={Object.entries(e.stopReasons).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ") || undefined} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat
          label={data.goal.label}
          value={pct(data.goal.rate)}
          sub={`${data.goal.reached} of ${data.goal.eligible} enrolled`}
        />
        <Stat
          label="Median time to fully onboarded"
          value={data.goal.medianHoursToOnboarded === null ? "—" : `${data.goal.medianHoursToOnboarded} h`}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Unknown</th>
              <th className="px-3 py-2">Opens</th>
              <th className="px-3 py-2">Clicks</th>
              <th className="px-3 py-2">Unsubscribes</th>
              <th className="px-3 py-2">Bounces</th>
              <th className="px-3 py-2">Complaints</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-neutral-500">
                  Nothing sent yet.
                </td>
              </tr>
            ) : null}
            {data.items.map((i) => (
              <tr key={`${i.poolId}:${i.itemId}`} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2">
                  <div className="font-medium">{i.label}</div>
                  <div className="text-xs text-neutral-500">
                    {Object.entries(i.byMode).map(([m, n]) => `${m}: ${n}`).join(" · ")}
                  </div>
                </td>
                <td className="px-3 py-2">{i.sent}</td>
                <td className="px-3 py-2">{i.unknown}</td>
                <td className="px-3 py-2">{i.opens}</td>
                <td className="px-3 py-2">{i.clicks}</td>
                <td className="px-3 py-2">{i.unsubscribes}</td>
                <td className="px-3 py-2">{i.bounces}</td>
                <td className="px-3 py-2">{i.complaints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        Opens and clicks only count when tracking is on (Settings). Shadow-mode emails are never counted as engagement.
        {data.truncated ? " Showing the most recent data only." : ""}
      </p>
    </div>
  );
}
