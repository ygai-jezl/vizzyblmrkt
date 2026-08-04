import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandAssetsEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import type { BrandAsset } from "@/lib/types/brandAsset";
import { BrandAssetLibrary } from "@/components/admin/brand-kit/BrandAssetLibrary";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Icons. The tenant's uploaded brand icons (raster). Tenant-global; reused as visual
 * references when brand images are generated. Flag-gated (BRAND_ASSETS_ENABLED).
 */
export default async function BrandKitIconsPage() {
  const ctx = await requireAdminContext();
  if (!isBrandAssetsEnabled()) notFound();

  let assets: BrandAsset[] = [];
  try {
    assets = await listBrandAssets(ctx, "icon");
  } catch (err) {
    console.error("[brand-kit] icons failed to load (index building?)", err);
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> Brand Kit
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Icons</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Upload your brand icons. They&apos;re reused as visual references so your generated
          imagery stays on brand.
        </p>
      </div>
      <BrandAssetLibrary category="icon" initialAssets={assets} tenantId={ctx.tenantId} />
    </div>
  );
}
