import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { ProductsHome } from "@/components/admin/connect/ProductsHome";

export const dynamic = "force-dynamic";

/**
 * Products — connect your own product (or a Sandbox) so lifecycle journeys know
 * your users and their onboarding state. Flag-gated (LIFECYCLE_ENABLED).
 */
export default async function ProductsPage() {
  const ctx = await requireAdminContext();
  if (!isLifecycleEnabled()) notFound();
  return <ProductsHome canEdit={ctx.role === "admin"} />;
}
