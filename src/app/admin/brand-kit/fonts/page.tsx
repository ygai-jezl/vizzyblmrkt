import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { isBrandFontsEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { listBrandFonts } from "@/lib/admin/brandFonts";
import type { BrandFont } from "@/lib/types/brandFont";
import { FontsManager } from "@/components/admin/brand-kit/FontsManager";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Fonts. The tenant's typography: named text styles + uploaded custom fonts +
 * guidelines. Everything authored here is tenant-global and grounds AI generation. Flag-gated
 * (BRAND_FONTS_ENABLED); degrades to an empty font list if the brand_fonts index is still building.
 */
export default async function BrandKitFontsPage() {
  const ctx = await requireAdminContext();
  if (!isBrandFontsEnabled()) notFound();

  const tenant = await getTenantById(ctx.tenantId);
  let fonts: BrandFont[] = [];
  try {
    fonts = await listBrandFonts(ctx);
  } catch (err) {
    console.error("[brand-kit] fonts failed to load (index building?)", err);
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
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Define your brand&apos;s text styles and upload custom fonts. These ground the typography
          of everything your brand generates.
        </p>
      </div>
      <FontsManager
        initialTypography={tenant?.brandTypography ?? null}
        initialFonts={fonts}
        tenantId={ctx.tenantId}
      />
    </div>
  );
}
