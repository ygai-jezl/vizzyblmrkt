import { redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { BrandSettings } from "@/components/admin/BrandSettings";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

/** Account → Brand: upload brand guidelines (PDF) → AI-extracted brand kit. */
export default async function AccountBrandPage() {
  // Nav v2 phase 3: the guidelines are part of Brand.
  if (isNavV2Phase3Enabled()) redirect("/admin/brand-kit/guidelines");
  await requireAdminContext();
  return <BrandSettings />;
}
