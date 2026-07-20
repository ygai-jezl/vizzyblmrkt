import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandKitEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { listImageAssets } from "@/lib/admin/brandKit";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { ImagesGallery } from "@/components/admin/brand-kit/ImagesGallery";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Images. The tenant-wide gallery of every AI-generated image across all
 * workspaces. Server-renders the first page; the client owns search + pagination +
 * the detail/customise modal. Degrades to an empty gallery if the index is still
 * building (logged, never a full-page 500). Flag-gated.
 */
export default async function BrandKitImagesPage() {
  const ctx = await requireAdminContext();
  if (!isBrandKitEnabled()) notFound();

  let images: ImageAsset[] = [];
  let cursor: string | null = null;
  try {
    const res = await listImageAssets(ctx, {});
    images = res.items;
    cursor = res.nextCursor;
  } catch (err) {
    console.error("[brand-kit] images failed to load (index building?)", err);
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
        <h1 className="mt-1 text-lg font-semibold">Images</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Every AI-generated image across your workspaces. Click one to view its details or
          customise it into a new image.
        </p>
      </div>
      <ImagesGallery initialImages={images} initialCursor={cursor} />
    </div>
  );
}
