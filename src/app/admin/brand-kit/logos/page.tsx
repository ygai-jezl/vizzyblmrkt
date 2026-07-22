import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandKitLogosEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { listLogos } from "@/lib/admin/brandLogos";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { LogosGallery } from "@/components/admin/brand-kit/LogosGallery";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Logos. The tenant's uploaded corporate logos. Server-renders the list; the
 * client owns upload + grid/list views + rename/set-primary/delete. Degrades to an empty
 * gallery if the brand_logos index is still building (logged, never a full-page 500).
 * Flag-gated (BRAND_KIT_LOGOS_ENABLED).
 */
export default async function BrandKitLogosPage() {
  const ctx = await requireAdminContext();
  if (!isBrandKitLogosEnabled()) notFound();

  let logos: BrandLogo[] = [];
  try {
    logos = await listLogos(ctx);
  } catch (err) {
    console.error("[brand-kit] logos failed to load (index building?)", err);
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
        <h1 className="mt-1 text-lg font-semibold">Logos</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Upload your corporate logos to reuse across your brand. The primary logo is used as
          the default header in your emails.
        </p>
      </div>
      <LogosGallery initialLogos={logos} tenantId={ctx.tenantId} />
    </div>
  );
}
