import type {
  HybridCampaignAnalytics,
  CountRow,
} from "@/lib/analytics/analytics";
import { BarList } from "@/components/admin/charts/BarList";
import { TimeSeries } from "@/components/admin/charts/TimeSeries";

/**
 * Presentational analytics view for a single campaign: a truncation banner, the
 * KPI stat grid, the signups-per-day bars, the widget-impression metrics (Views
 * over Time + true Referrer Sources, from the BigQuery view-beacon pipeline), and
 * the UTM/referrer breakdown tables. Pure (server-safe) — it just renders a
 * HybridCampaignAnalytics object.
 *
 * KPI cards + signup breakdowns are always present (Firestore real-time or
 * BigQuery at scale). The impression metrics are present only when widget
 * view-tracking is configured AND has data; otherwise an explanatory note is
 * shown (PRD §4.2: these require the embeddable widget layer + the pipeline).
 *
 * Shared by the global Analytics page (which adds the campaign-switcher pills)
 * and the per-launch Analytics tab (already scoped to one launch), so both
 * render identically.
 */
export function CampaignAnalyticsView({
  analytics: a,
}: {
  analytics: HybridCampaignAnalytics;
}) {
  const viewsActive = a.source.views === "bigquery";
  return (
    <div className="space-y-6">
      {a.truncated ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Headline totals are based on the first 10,000 signups. Enable the
          BigQuery pipeline for exact full-scale totals (docs/SETUP.md §11).
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

      <Section
        title="Views over time"
        tip="Widget impressions — every time the embedded widget renders, even without a signup. Requires the no-code widget layer + the BigQuery pipeline; headless/API integrations are not counted."
      >
        {viewsActive && a.viewsByDay?.length ? (
          <TimeSeries rows={a.viewsByDay} label="views" />
        ) : (
          <Empty>
            View tracking isn’t active for this launch yet. Embed the widget (it
            beacons impressions automatically) and enable the BigQuery pipeline
            (docs/SETUP.md §11) to populate this.
          </Empty>
        )}
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <UtmTable title="UTM Source" rows={a.utm.source} />
        <UtmTable title="UTM Medium" rows={a.utm.medium} />
        <UtmTable title="UTM Campaign" rows={a.utm.campaign} />
        <UtmTable title="UTM Content" rows={a.utm.content} />
        <UtmTable title="UTM Term" rows={a.utm.term} />
        <UtmTable
          title="Referrer sources (views)"
          rows={viewsActive ? (a.viewReferrerSources ?? []) : []}
          tip="Where viewers came from before seeing the widget (all impressions). Requires the widget layer + the BigQuery pipeline."
          emptyNote={
            viewsActive
              ? undefined
              : "Needs widget view-tracking — see “Views over time” above."
          }
        />
        <UtmTable
          title="Referrers (of signups)"
          rows={a.referrerSources}
          tip="Referrer host of people who actually signed up (captured at conversion). Available without view-tracking."
        />
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

function Section({
  title,
  tip,
  children,
}: {
  title: string;
  tip?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        {title}
        {tip ? <Tip text={tip} /> : null}
      </h2>
      {children}
    </section>
  );
}

/** Native-title info marker — a hover tooltip with no client JS (server-safe). */
function Tip({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[10px] font-normal text-neutral-400 dark:border-neutral-700"
    >
      i
    </span>
  );
}

function UtmTable({
  title,
  rows,
  tip,
  emptyNote,
}: {
  title: string;
  rows: CountRow[];
  tip?: string;
  emptyNote?: string;
}) {
  return (
    <Section title={title} tip={tip}>
      {rows.length === 0 ? (
        <Empty>{emptyNote ?? "No data."}</Empty>
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
