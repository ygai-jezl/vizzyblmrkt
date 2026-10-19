import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { BRAND_KIT_ROUTE, isBrandAssetsEnabled } from "@/lib/content/brandKit";
import { isBrandImageStyleEnabled } from "@/lib/content/imageStyle/flags";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import type { BrandAsset } from "@/lib/types/brandAsset";
import { BrandAssetLibrary } from "@/components/admin/brand-kit/BrandAssetLibrary";

export const dynamic = "force-dynamic";

/**
 * Brand › Screenshots (BRAND_IMAGE_STYLE_ENABLED): screens of the brand's product that template
 * styles build from (Product noir). Also filled from the style picker, at the moment someone
 * makes an image in a style that needs them. Never sent to the image model as references.
 */
export default async function BrandKitScreenshotsPage() {
  const ctx = await requireAdminContext();
  if (!isBrandImageStyleEnabled() || !isBrandAssetsEnabled()) notFound();

  let assets: BrandAsset[] = [];
  try {
    assets = await listBrandAssets(ctx, "screenshot");
  } catch (err) {
    console.error("[brand-kit] screenshots failed to load (index building?)", err);
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {isNavV2Phase3Enabled() ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Screenshots</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Screens of your product, used by template styles such as Product noir. PNG or JPG. Crop out customer
          names, emails and private numbers first.
        </p>
      </div>
      <BrandAssetLibrary category="screenshot" initialAssets={assets} tenantId={ctx.tenantId} />
    </div>
  );
}
