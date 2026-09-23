import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant, getTenantById } from "@/lib/tenant";
import { renderBrandVoice } from "@/lib/agents/prompts/compose";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { WorkspaceSettings } from "@/components/admin/workspace/WorkspaceSettings";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();
  // Nav v2 phase 3: say plainly when the brand voice is the one in use (it wins
  // over this programme's own voice whenever it's set — see resolveBrandVoiceText).
  const phase3 = isNavV2Phase3Enabled();
  const tenant = phase3 ? await getTenantById(ctx.tenantId).catch(() => null) : null;
  const brandVoiceActive = !!tenant && renderBrandVoice(tenant.brandVoice).trim().length > 0;

  return (
    <WorkspaceSettings
      workspaceId={workspaceId}
      initial={{
        topics: ws.topics ?? [],
        defaultTags: ws.defaultTags ?? [],
        brandVoice: ws.brandVoice ?? "",
        audience: ws.audience ?? "",
      }}
      programme={phase3}
      brandVoiceActive={brandVoiceActive}
    />
  );
}
