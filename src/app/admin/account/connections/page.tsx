import { Suspense } from "react";
import { requireAdminContext } from "@/lib/auth/session";
import { ConnectionsPanel } from "@/components/admin/ConnectionsPanel";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  await requireAdminContext();
  return (
    <Suspense>
      <ConnectionsPanel />
    </Suspense>
  );
}
