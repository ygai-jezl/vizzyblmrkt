import { requireAdminContext } from "@/lib/auth/session";
import { BrandSettings } from "@/components/admin/BrandSettings";

export const dynamic = "force-dynamic";

/** Account → Brand: upload brand guidelines (PDF) → AI-extracted brand kit. */
export default async function AccountBrandPage() {
  await requireAdminContext();
  return <BrandSettings />;
}
