import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { BRAND_KIT_COMPETITORS_ROUTE, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors, onBrandMap, unseenChanges } from "@/lib/competitors/store";
import { summaryOf } from "@/lib/competitors/view";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { competitorsDoor } from "@/lib/brandStrategy/adminApi";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";
import { CompetitorsPage } from "@/components/admin/brand-kit/CompetitorsPage";

export const dynamic = "force-dynamic";

/**
 * Brand › Competitors (COMPETITORS_ENABLED): the competitors a brand watches. Members can view
 * them; only admins add one, change one or stop watching.
 */
export default async function CompetitorsRoute({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const ctx = await requireAdminContext();
  if (!isCompetitorsEnabled()) notFound();
  const included = await brandCanUse(ctx, "competitors");
  const { list, door } = included
    ? await (async () => {
        const competitors = await listCompetitors(ctx);
        // Joined to the strategy (STRATEGY_COMPETITORS_ENABLED): the finder's suggestions and Find competitors here too.
        const [changes, mapped, joined] = await Promise.all([unseenChanges(ctx), onBrandMap(ctx, competitors), competitorsDoor(ctx, competitors).catch(() => null)]);
        return { list: competitors.map((c) => summaryOf(c, changes, mapped.has(c.id))), door: joined };
      })().catch((err) => {
        console.error("[competitors] read failed", err);
        return { list: [], door: null };
      })
    : { list: [], door: null };
  const coverage = included && isCompetitorArticlesEnabled() && (await brandCanUse(ctx, "competitor_articles"));
  const prefill = ((await searchParams).name ?? "").replace(/[\r\n]/g, " ").trim().slice(0, COMPETITOR_LIMITS.MAX_NAME);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Competitors</h1>
        <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Watch the businesses you compete with. We learn how their website is built, then tell you when they publish
          something new or change their site.
        </p>
        {coverage ? (
          <Link href={`${BRAND_KIT_COMPETITORS_ROUTE}/coverage`} className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">
            What they write about
          </Link>
        ) : null}
      </div>
      {included ? (
        <CompetitorsPage initial={list} canEdit={ctx.role === "admin"} prefillName={prefill} door={door} />
      ) : (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          Competitors isn&rsquo;t included for this brand.
        </p>
      )}
    </div>
  );
}
