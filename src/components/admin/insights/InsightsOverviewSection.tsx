import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { isContentSteeringUiEnabled } from "@/lib/content/brandKit";
import { loadInsightsOverview, type SignupSources } from "@/lib/insights/overview";
import { WeeklyBars } from "@/components/admin/charts/WeeklyBars";
import { LaunchFunnel } from "@/components/admin/invites/LaunchFunnel";
import { Card, RoadmapCard, Tiles, pct } from "./parts";

/** Where the source numbers come from, said plainly. */
export function sourcesNote(s: SignupSources): string {
  if (s.basis === "none") return "not available right now";
  const base = "last 30 days · estimated from UTM tags and referring sites";
  return s.sampled ? `${base} · newest 5,000 signups` : base;
}

/** Signups by source as labelled rows (one series: each row names itself). */
export function SourceList({ sources }: { sources: SignupSources }) {
  if (sources.rows.length === 0) return <p className="text-sm text-neutral-500">No signups in the last 30 days.</p>;
  const max = Math.max(1, ...sources.rows.map((r) => r.count));
  return (
    <ul className="space-y-1.5" aria-label="Signups by source">
      {sources.rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[9.5rem_1fr_3rem] items-center gap-2 text-xs" title={`${r.label}: ${r.count}`}>
          <span className="truncate text-neutral-600 dark:text-neutral-300">
            {r.label}
            {r.content ? <span className="ml-1 text-neutral-400">· content</span> : null}
          </span>
          <span className="h-3 rounded bg-neutral-100 dark:bg-neutral-900" aria-hidden>
            <span className="block h-3 rounded bg-blue-600 dark:bg-blue-500" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{r.count.toLocaleString("en-GB")}</span>
        </li>
      ))}
    </ul>
  );
}

/** Insights › Overview (nav v2 phase 4). */
export async function InsightsOverviewSection() {
  const ctx = await requireAdminContext();
  const invites = isInvitesUiEnabled() && isInvitesEnabled();
  const o = await loadInsightsOverview(ctx, { lifecycle: isLifecycleEnabled(), invites });
  const topContent = o.sources.contentCampaigns.slice(0, 3);

  return (
    <div className="space-y-6">
      <Tiles tiles={o.tiles} />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <WeeklyBars title="Signups per week, all launches" unit="signups" points={o.weeks.map((w) => ({ start: w.start, value: w.signups }))} />
        </section>
        <Card title="Where signups come from" note={sourcesNote(o.sources)}>
          <SourceList sources={o.sources} />
        </Card>
      </div>
      <Card title="What's working">
        <ul className="space-y-2 text-sm">
          <li>
            <span className="font-medium">Content that brings signups: </span>
            {topContent.length ? (
              topContent.map((c, i) => (
                <span key={c.value}>
                  {i > 0 ? ", " : ""}
                  “{c.value}” ({c.count.toLocaleString("en-GB")})
                </span>
              ))
            ) : (
              <span className="text-neutral-500">
                none tagged yet. Add <code className="text-xs">utm_campaign</code> to the links in your posts and newsletters to see which ones work.
              </span>
            )}
          </li>
          <li>
            <span className="font-medium">Best email by clicks: </span>
            {o.bestEmail ? (
              <span>
                {o.bestEmail.name} · {pct(o.bestEmail.clickRate)} clicked ({o.bestEmail.sends.toLocaleString("en-GB")} sent, last 30 days)
              </span>
            ) : (
              <span className="text-neutral-500">not enough sends yet (an email needs 50).</span>
            )}
          </li>
          {isContentSteeringUiEnabled() ? (
            <li>
              <Link href="/admin/brand-kit/steering" className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                What&rsquo;s working in your content posts →
              </Link>
            </li>
          ) : null}
        </ul>
      </Card>
      {o.funnel ? (
        <Card title="From waitlist to product" note="every launch">
          <LaunchFunnel funnel={o.funnel} />
        </Card>
      ) : null}
      <RoadmapCard />
    </div>
  );
}
