import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { WAITLIST_STATUS_LABEL } from "@/lib/journey/waitlistJourneyRows";
import { loadJourneyInsights } from "@/lib/insights/journeys";
import { Card } from "@/components/admin/insights/parts";

export const dynamic = "force-dynamic";

const TH = "px-3 py-2 text-left text-xs font-medium text-neutral-500";
const TD = "px-3 py-2";
const n = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-GB"));

/** Insights › Journeys (nav v2 phase 4): welcome journeys and product journeys side by side. */
export default async function InsightsJourneysPage() {
  if (!isInsightsHubEnabled()) notFound();
  const ctx = await requireAdminContext();
  const lifecycle = isLifecycleEnabled();
  const j = await loadJourneyInsights(ctx, { lifecycle });
  const anyWaiting = j.welcome.some((w) => (w.waiting ?? 0) > 0);
  return (
    <div className="space-y-6">
      <Card title="Welcome journeys" note="one per launch">
        {j.welcome.length === 0 ? (
          <p className="text-sm text-neutral-500">No launch has a welcome journey yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className={TH}>Launch</th>
                <th className={TH}>Status</th>
                <th className={`${TH} text-right`}>Emails</th>
                <th className={`${TH} text-right`}>People part-way</th>
                {anyWaiting ? <th className={`${TH} text-right`}>Waiting (paused)</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {j.welcome.map((w) => (
                <tr key={w.campaignId}>
                  <td className={TD}>
                    <Link href={w.href} className="hover:underline">
                      {w.launchName}
                    </Link>
                  </td>
                  <td className={TD}>{WAITLIST_STATUS_LABEL[w.status]}</td>
                  <td className={`${TD} text-right tabular-nums`}>{w.emails}</td>
                  <td className={`${TD} text-right tabular-nums`}>{n(w.inProgress)}</td>
                  {anyWaiting ? <td className={`${TD} text-right tabular-nums`}>{n(w.waiting)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {lifecycle ? (
        <Card title="Product journeys" note="sends are the last 7 days">
          {j.lifecycle.length === 0 ? (
            <p className="text-sm text-neutral-500">No product journeys yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  <th className={TH}>Journey</th>
                  <th className={TH}>Mode</th>
                  <th className={`${TH} text-right`}>In it</th>
                  <th className={`${TH} text-right`}>Finished</th>
                  <th className={`${TH} text-right`}>Left early</th>
                  <th className={`${TH} text-right`}>Sends</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {j.lifecycle.map((l) => (
                  <tr key={l.id}>
                    <td className={TD}>
                      <Link href={l.href} className="hover:underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className={TD}>{l.status === "paused" ? "paused" : l.deliveryMode}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(l.active)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(l.completed)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(l.exited)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(l.sends7d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}
    </div>
  );
}
