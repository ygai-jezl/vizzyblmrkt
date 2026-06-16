import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import {
  computeCampaignAnalytics,
  type CountRow,
} from "@/lib/analytics/analytics";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const ctx = await requireAdminContext();
  const sp = await searchParams;

  const campaigns = await forTenant(ctx).campaigns.find({
    orderBy: [["createdAt", "desc"]],
    limit: 50,
  });

  if (campaigns.length === 0) {
    return <p className="text-sm text-neutral-500">No campaigns yet.</p>;
  }

  const selected =
    campaigns.find((c) => c.id === sp.campaign) ?? campaigns[0]!;
  const a = await computeCampaignAnalytics(ctx, selected.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Analytics</h1>
        {campaigns.length > 1 ? (
          <div className="flex gap-2 text-sm">
            {campaigns.map((c) => (
              <Link
                key={c.id}
                href={`/admin/analytics?campaign=${c.id}`}
                className={`rounded-md border px-3 py-1 ${
                  c.id === selected.id
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {c.waitlistName}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {a.truncated ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Showing the first 10,000 signups. Connect the BigQuery pipeline for
          full-scale analytics (docs/SETUP.md §11).
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total signups" value={a.totalSignups} hint="verified + unverified" />
        <Stat label="Verified" value={a.verifiedSignups} />
        <Stat label="Unverified" value={a.unverifiedSignups} />
        <Stat label="Offboarded" value={a.offboardedSignups} />
        <Stat label="Total referrals" value={a.totalReferrals} />
        <Stat label="Referred" value={a.referredSignups} />
        <Stat label="Organic" value={a.organicSignups} />
        <Stat label="Last signup" value={relative(a.lastSignupAt)} small />
      </div>

      <Section title="Signups per day">
        {a.signupsByDay.length ? (
          <BarList rows={a.signupsByDay} />
        ) : (
          <Empty>No signups yet.</Empty>
        )}
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <UtmTable title="UTM Source" rows={a.utm.source} />
        <UtmTable title="UTM Medium" rows={a.utm.medium} />
        <UtmTable title="UTM Campaign" rows={a.utm.campaign} />
        <UtmTable title="UTM Content" rows={a.utm.content} />
        <UtmTable title="UTM Term" rows={a.utm.term} />
        <UtmTable title="Referrer sources" rows={a.referrerSources} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  small,
}: {
  label: string;
  value: number | string;
  hint?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={small ? "mt-1 text-base font-medium" : "mt-1 text-2xl font-semibold tabular-nums"}>
        {value}
      </div>
      {hint ? <div className="text-xs text-neutral-400">{hint}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function BarList({ rows }: { rows: CountRow[] }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.value} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 tabular-nums text-neutral-500">{r.value}</span>
          <div className="h-4 flex-1 rounded bg-neutral-100 dark:bg-neutral-900">
            <div
              className="h-4 rounded bg-neutral-800 dark:bg-neutral-300"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right tabular-nums">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

function UtmTable({ title, rows }: { title: string; rows: CountRow[] }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <Empty>No data.</Empty>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.value} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-1.5">{r.value}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">
      {children}
    </p>
  );
}

function relative(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
