import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { ConnectionDetail } from "@/components/admin/connect/ConnectionDetail";

export const dynamic = "force-dynamic";

/** One connected product: sandbox, event debugger, users, context test, catalog, settings. */
export default async function ConnectionPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const ctx = await requireAdminContext();
  if (!isLifecycleEnabled()) notFound();
  const { connectionId } = await params;
  return <ConnectionDetail connectionId={connectionId} canEdit={ctx.role === "admin"} />;
}
