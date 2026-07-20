import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isBrandKitEnabled } from "@/lib/content/brandKit";
import { CategoryGrid } from "@/components/admin/brand-kit/CategoryGrid";

export const dynamic = "force-dynamic";

/**
 * Brand Kit — the tenant's reusable brand assets, Canva-style. v1 ships the category
 * grid with only "Images" (the AI image library) functional; the rest are placeholders.
 * Distinct from Account → Brand (the brand GUIDELINES kit). Flag-gated.
 */
export default async function BrandKitPage() {
  await requireAdminContext();
  if (!isBrandKitEnabled()) notFound();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Brand Kit</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Your brand&apos;s reusable assets. Only Images is available today — more coming soon.
        </p>
      </div>
      <CategoryGrid />
    </div>
  );
}
