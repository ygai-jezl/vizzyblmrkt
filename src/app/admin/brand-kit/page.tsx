import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandKitEnabled } from "@/lib/content/brandKit";
import { CategoryGrid } from "@/components/admin/brand-kit/CategoryGrid";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

/**
 * Brand Kit — the tenant's reusable brand assets, Canva-style. v1 ships the category
 * grid with only "Images" (the AI image library) functional; the rest are placeholders.
 * Distinct from Account → Brand (the brand GUIDELINES kit). Flag-gated.
 */
export default async function BrandKitPage() {
  await requireAdminContext();
  if (!isBrandKitEnabled()) notFound();

  // Nav v2 phase 3: this is Brand, the one home for how the brand looks and sounds.
  const phase3 = isNavV2Phase3Enabled();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{phase3 ? "Brand" : "Brand Kit"}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {phase3
            ? "How your brand looks and sounds. Everything here is applied across your content, emails and pages."
            : "Your brand's reusable assets. Everything you define here is applied globally across your generated content."}
        </p>
      </div>
      <CategoryGrid phase3={phase3} />
    </div>
  );
}
