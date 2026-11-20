import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { deleteTenantGitConnection, getTenantById } from "@/lib/tenant";
import { isGitProvider, type GitProvider } from "@/lib/integrations/providers";
import { isConnectorRevokeEnabled } from "@/lib/integrations/flags";
import { revokeGitConnection } from "@/lib/integrations/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stored connection, read before the delete. A failed read gives null: Disconnect
 *  still goes ahead, there is just nothing to revoke. */
async function storedConnection(tenantId: string, provider: GitProvider) {
  try {
    return (await getTenantById(tenantId))?.gitConnections?.[provider] ?? null;
  } catch {
    return null;
  }
}

/**
 * Disconnect a git provider (delete the stored encrypted token). Admins only.
 * With CONNECTOR_REVOKE_ENABLED on, the connection is read first, deleted here, and then
 * its token is revoked at GitLab or classic GitHub, best effort: the response says
 * `revoked` and a failed revoke still disconnects. A GitHub App is never uninstalled.
 * Switch off: no read and no provider call, as before.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { provider } = await params;
  if (!isGitProvider(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }
  if (!isConnectorRevokeEnabled()) {
    await deleteTenantGitConnection(ctx.tenantId, provider);
    return NextResponse.json({ ok: true });
  }
  // Keep the connection in memory: once deleted, its token can't be read back.
  const conn = await storedConnection(ctx.tenantId, provider);
  await deleteTenantGitConnection(ctx.tenantId, provider);
  const { result: revoked } = await revokeGitConnection(ctx.tenantId, conn);
  return NextResponse.json({ ok: true, revoked });
}
