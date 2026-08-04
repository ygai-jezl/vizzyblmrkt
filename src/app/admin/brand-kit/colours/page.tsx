import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { isBrandColorsEnabled, BRAND_KIT_ROUTE } from "@/lib/content/brandKit";
import { BrandColoursPage } from "@/components/admin/brand-kit/BrandColoursPage";

export const dynamic = "force-dynamic";

/**
 * Brand Kit → Colours. Build + manage the tenant's palette (and named palette groups). Reuses the
 * BrandColours card from Account → Brand, self-saving via /api/admin/brand-kit/colours. The palette
 * hexes already ground on-brand AI generation via assembleBrandContext. Flag-gated (BRAND_COLORS).
 */
export default async function BrandKitColoursPage() {
  const ctx = await requireAdminContext();
  if (!isBrandColorsEnabled()) notFound();

  const tenant = await getTenantById(ctx.tenantId);
  const kit = tenant?.brandKit ?? {};

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> Brand Kit
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Colours</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Your brand palette. Build it from your website, brand PDF, logo, or an AI theme — then
          keep the ones you want. These colours ground your generated content.
        </p>
      </div>
      <BrandColoursPage
        initialPalette={kit.palette ?? []}
        initialPalettes={kit.palettes ?? []}
        pdfPath={kit.pdfPath ?? null}
      />
    </div>
  );
}
