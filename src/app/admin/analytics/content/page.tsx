import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { isContentSteeringUiEnabled } from "@/lib/content/brandKit";
import { loadSignupSources } from "@/lib/insights/overview";
import { SourceList, sourcesNote } from "@/components/admin/insights/InsightsOverviewSection";
import { Card } from "@/components/admin/insights/parts";

export const dynamic = "force-dynamic";

/** Insights › Content (nav v2 phase 4): which content brings signups, and how much is going out. */
export default async function InsightsContentPage() {
  if (!isInsightsHubEnabled()) notFound();
  const ctx = await requireAdminContext();
  const repos = forTenant(ctx);
  const [sources, posts, newsletters] = await Promise.all([
    loadSignupSources(ctx, new Date()),
    repos.scheduledPosts.count([["jobKind", "==", "publish"]]).catch(() => null),
    repos.broadcasts
      .count([
        ["audienceMode", "==", "weekly"],
        ["status", "==", "sent"],
      ])
      .catch(() => null),
  ]);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Where signups come from" note={sourcesNote(sources)}>
          <SourceList sources={sources} />
        </Card>
        <Card title="Content campaigns that bring signups" note="by utm_campaign">
          {sources.contentCampaigns.length === 0 ? (
            <p className="text-sm text-neutral-500">
              None tagged yet. Add <code className="text-xs">utm_campaign</code> (and a source like linkedin or newsletter) to
              the links in your posts and newsletters to see which ones bring people in.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sources.contentCampaigns.map((c) => (
                <li key={c.value} className="flex justify-between gap-3">
                  <span className="truncate">{c.value}</span>
                  <span className="tabular-nums">{c.count.toLocaleString("en-GB")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="What's going out">
        <p className="text-sm">
          {posts == null ? "—" : posts.toLocaleString("en-GB")} posts sent to Distribute ·{" "}
          {newsletters == null ? "—" : newsletters.toLocaleString("en-GB")} newsletters sent to a waitlist.{" "}
          <Link href="/admin/workspace" className="text-blue-700 hover:underline dark:text-blue-300">
            Go to Content →
          </Link>
        </p>
        {isContentSteeringUiEnabled() ? (
          <Link href="/admin/brand-kit/steering" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
            What&rsquo;s working in your posts →
          </Link>
        ) : null}
      </Card>
    </div>
  );
}
