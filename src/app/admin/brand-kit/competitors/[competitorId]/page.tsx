import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { BRAND_KIT_COMPETITORS_ROUTE } from "@/lib/content/brandKit";
import { isCompetitorsEnabled } from "@/lib/competitors/flags";
import { getCompetitor, listChanges, listPosts, onBrandMap } from "@/lib/competitors/store";
import { articlesForDetail } from "@/lib/competitors/coverage";
import { detailOf } from "@/lib/competitors/view";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { isStrategyCompetitorsEnabled } from "@/lib/brandStrategy/flags";
import { CompetitorDetail } from "@/components/admin/brand-kit/CompetitorDetail";

export const dynamic = "force-dynamic";

/** Brand › Competitors › one competitor (COMPETITORS_ENABLED). Members view; admins change it. */
export default async function CompetitorRoute({ params }: { params: Promise<{ competitorId: string }> }) {
  const ctx = await requireAdminContext();
  if (!isCompetitorsEnabled() || !(await brandCanUse(ctx, "competitors"))) notFound();
  const { competitorId } = await params;
  const c = await getCompetitor(ctx, competitorId);
  if (!c) notFound();
  const [changes, posts, mapped, articles] = await Promise.all([
    listChanges(ctx, c.id),
    listPosts(ctx, c.id),
    onBrandMap(ctx, [c]),
    articlesForDetail(ctx, c.id).catch(() => null),
  ]);

  return (
    <div className="space-y-5">
      <Link
        href={BRAND_KIT_COMPETITORS_ROUTE}
        className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        <ChevronLeft size={14} /> Competitors
      </Link>
      <CompetitorDetail initial={detailOf(c, changes, posts, mapped.has(c.id), articles)} canEdit={ctx.role === "admin"} grouping={isStrategyCompetitorsEnabled()} />
    </div>
  );
}
