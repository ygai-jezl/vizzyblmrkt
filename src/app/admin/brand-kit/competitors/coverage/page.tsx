import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { isBlogBrandMapEnabled } from "@/lib/content/blog/flags";
import { forTenant } from "@/lib/tenant";
import { BRAND_KIT_COMPETITORS_ROUTE } from "@/lib/content/brandKit";
import { competitorCoverage } from "@/lib/competitors/coverage";
import { isCompetitorArticlesPlanningEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { CompetitorCoverage } from "@/components/admin/brand-kit/CompetitorCoverage";

export const dynamic = "force-dynamic";

/**
 * Brand › Competitors › What they write about (COMPETITOR_ARTICLES_ENABLED): the brand map's
 * subjects beside how much each competitor wrote on them in the last 90 days, and how much the
 * brand has. Members view, and open a subject's box to plan an article; admins add new subjects
 * to the map (COMPETITOR_ARTICLES_PLANNING_ENABLED).
 */
export default async function CompetitorCoverageRoute() {
  const ctx = await requireAdminContext();
  if (!isCompetitorsEnabled() || !(await brandCanUse(ctx, "competitors"))) notFound();
  const view = await competitorCoverage(ctx).catch((err) => {
    console.error("[competitors] coverage read failed", err);
    return null;
  });
  if (!view) notFound();
  const planning = isCompetitorArticlesPlanningEnabled();
  // Write this next needs articles written from the map, and somewhere to write them (as on Brand map).
  const writeNextOn = planning && view.moved && isBrandMapPagesEnabled() && isBlogBrandMapEnabled();
  const workspaces = writeNextOn ? await forTenant(ctx).workspaces.find({ where: [], limit: 200 }).catch(() => []) : [];
  const programmes = writeNextOn ? workspaces.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name })) : null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_COMPETITORS_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> Competitors
        </Link>
        <h1 className="mt-1 text-lg font-semibold">What they write about</h1>
        <p className="max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Your brand map&rsquo;s subjects beside the articles each competitor published on them in the last {view.days} days. You
          counts the questions on a subject you have answered, drafted or planned.
        </p>
      </div>
      <CompetitorCoverage view={view} canEdit={ctx.role === "admin" && planning} canPlan={planning && view.moved} programmes={programmes} />
    </div>
  );
}
