import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { loadEmailInsights } from "@/lib/insights/email";
import { Card, pct } from "@/components/admin/insights/parts";

export const dynamic = "force-dynamic";

const TH = "px-3 py-2 text-left text-xs font-medium text-neutral-500";
const TD = "px-3 py-2";

/** Insights › Email (nav v2 phase 4): every automated email programme and recent broadcasts. */
export default async function InsightsEmailPage() {
  if (!isInsightsHubEnabled()) notFound();
  const ctx = await requireAdminContext();
  const e = await loadEmailInsights(ctx, {
    lifecycle: isLifecycleEnabled(),
    invites: isInvitesUiEnabled() && isInvitesEnabled(),
  });
  return (
    <div className="space-y-6">
      <Card title="Automated emails" note={`${e.basis} · opens and clicks count people, not repeat opens`}>
        {e.programmes.length === 0 ? (
          <p className="text-sm text-neutral-500">No automated emails have gone out yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  <th className={TH}>Emails</th>
                  <th className={`${TH} text-right`}>Sent</th>
                  <th className={`${TH} text-right`}>Opened</th>
                  <th className={`${TH} text-right`}>Clicked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {e.programmes.map((p) => (
                  <tr key={p.id}>
                    <td className={TD}>
                      <Link href={p.href} className="hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{p.sends.toLocaleString("en-GB")}</td>
                    <td className={`${TD} text-right tabular-nums`}>{pct(p.openRate)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{pct(p.clickRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Broadcasts" note="rates reported by MailChimp">
        {e.broadcasts.length === 0 ? (
          <p className="text-sm text-neutral-500">No broadcasts sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  <th className={TH}>Broadcast</th>
                  <th className={TH}>Sent</th>
                  <th className={`${TH} text-right`}>To</th>
                  <th className={`${TH} text-right`}>Opened</th>
                  <th className={`${TH} text-right`}>Clicked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {e.broadcasts.map((b) => (
                  <tr key={b.id}>
                    <td className={TD}>
                      <Link href={`/admin/launches/${b.campaignId}/broadcasts`} className="hover:underline">
                        {b.name}
                      </Link>
                    </td>
                    <td className={`${TD} text-neutral-500`}>
                      {b.sentAt ? new Date(b.sentAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{b.sends.toLocaleString("en-GB")}</td>
                    <td className={`${TD} text-right tabular-nums`}>{pct(b.openRate)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{pct(b.clickRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
