import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isBrandMapEnabled, isBrandMapPagesEnabled, isBrandMapResearchEnabled, isBrandMapWikidataEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { computeCoverage } from "@/lib/content/blog/coverage";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import { isGeminiConfigured } from "@/lib/agents/gemini";
import { readBrandMap, type BrandMapRead } from "@/lib/brandMap/store";
import { BrandMapEditor } from "@/components/admin/brand-kit/BrandMapEditor";
import { decidedOf } from "@/components/admin/brand-kit/brandMapForm";

export const dynamic = "force-dynamic";

/**
 * Brand › Brand map (BRAND_MAP_ENABLED): one set of names and subjects that every blog
 * article is written from. Members can view it; only admins save it, accept or dismiss a
 * suggestion, run research or look up an identifier.
 */
export default async function BrandMapPage() {
  const ctx = await requireAdminContext();
  if (!isBrandMapEnabled()) notFound();

  const pagesOn = isBrandMapPagesEnabled();
  const [read, tenant, pages] = await Promise.all([
    readBrandMap(ctx).catch((err): BrandMapRead => {
      console.error("[brand-map] read failed", err);
      return { state: "none" };
    }),
    getTenantById(ctx.tenantId).catch(() => null),
    pagesOn
      ? listBrandMapPages(ctx).catch((err): BrandMapPage[] => {
          console.error("[brand-map] pages read failed", err);
          return [];
        })
      : ([] as BrandMapPage[]),
  ]);
  const map = read.state === "ok" ? read.map : null;
  // What the brand's pages answer, worked out now from the saved map (never stored).
  const coverage = pagesOn && map && map.rev > 0 ? computeCoverage(map, pages) : null;
  const root = tenant?.rootDomain?.trim();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Brand map</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">One set of names and subjects. Every article is written from it.</p>
      </div>
      <BrandMapEditor
        initial={decidedOf(map)}
        rev={map?.rev ?? 0}
        suggestions={map?.suggestions ?? []}
        research={map?.research ?? null}
        unreadable={read.state === "unreadable"}
        canEdit={ctx.role === "admin"}
        canResearch={isBrandMapResearchEnabled() && isGeminiConfigured()}
        canLookup={isBrandMapWikidataEnabled()}
        defaults={{ name: tenant?.tenantName?.trim() ?? "", site: root ? `https://${root.replace(/^https?:\/\//, "")}` : "" }}
        coverage={coverage}
      />
    </div>
  );
}
