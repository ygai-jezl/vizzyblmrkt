import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { JourneysHome } from "@/components/admin/lifecycle/JourneysHome";

export const dynamic = "force-dynamic";

/** Lifecycle journeys for connected products. Flag-gated (LIFECYCLE_ENABLED). */
export default async function LifecyclePage() {
  const ctx = await requireAdminContext();
  if (!isLifecycleEnabled()) notFound();
  return <JourneysHome canEdit={ctx.role === "admin"} />;
}
