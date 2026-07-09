import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isEbookUiEnabled } from "@/lib/content/create/ebook";
import { EbookStudio } from "@/components/admin/workspace/create/ebook/EbookStudio";

export const dynamic = "force-dynamic";

/** Full-screen eBook authoring studio for one eBook content plan (before it's finalized
 *  onto the canvas). 404s unless the feature is on and the plan is an eBook plan. */
export default async function EbookStudioPage({
  params,
}: {
  params: Promise<{ workspaceId: string; planId: string }>;
}) {
  if (!isEbookUiEnabled()) notFound();
  const ctx = await requireAdminContext();
  const { workspaceId, planId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan || plan.topology.hubChannel !== "ebook") notFound();

  return (
    <EbookStudio
      workspaceId={workspaceId}
      planId={planId}
      planName={plan.name}
      initialEbook={plan.ebookDraft ?? null}
    />
  );
}
