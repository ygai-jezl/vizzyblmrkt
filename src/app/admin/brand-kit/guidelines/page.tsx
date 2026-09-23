import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { BRAND_KIT_ROUTE, isBrandKitUiEnabled } from "@/lib/content/brandKit";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { BrandSettings } from "@/components/admin/BrandSettings";

export const dynamic = "force-dynamic";

/**
 * Brand → Guidelines (nav v2 phase 3): the brand-guidelines PDF and what the AI
 * extracted from it. Moved here from Account → Brand, so everything about how the
 * brand looks and sounds has one home.
 */
export default async function BrandGuidelinesPage() {
  if (!isNavV2Phase3Enabled()) notFound();
  await requireAdminContext();
  return (
    <div className="space-y-5">
      <div>
        {isBrandKitUiEnabled() ? (
          <Link
            href={BRAND_KIT_ROUTE}
            className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <ChevronLeft size={14} /> Brand
          </Link>
        ) : null}
        <h1 className="mt-1 text-lg font-semibold">Brand guidelines</h1>
        <p className="max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">
          Upload your guidelines as a PDF and we pull out colours, fonts, tone, and do&rsquo;s and don&rsquo;ts. The tone and
          voice here guide images and email layouts; written copy follows your Brand voice.
        </p>
      </div>
      <BrandSettings />
    </div>
  );
}
