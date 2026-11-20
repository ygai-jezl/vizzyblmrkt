import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { deleteTenantSocialConnection } from "@/lib/tenant";
import { isConnectorRevokeEnabled, isConnectorRevokeXEnabled } from "@/lib/integrations/flags";
import { revokeSocialConnection, storedSocialTokens } from "@/lib/social/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect the tenant's X account (removes the encrypted tokens). With
 * CONNECTOR_REVOKE_ENABLED on, the response says `revoked`; X's tokens are read first,
 * deleted here, then revoked at X only when CONNECTOR_REVOKE_X_ENABLED is on too. A
 * failed revoke still disconnects. Switch off: no read and no call to X, as before.
 */
export async function DELETE(req: Request) {
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  if (!isConnectorRevokeEnabled()) {
    await deleteTenantSocialConnection(ctx.tenantId, "x");
    return NextResponse.json({ ok: true });
  }
  // Keep the tokens in memory: once deleted, they can't be read back.
  const tokens = isConnectorRevokeXEnabled() ? await storedSocialTokens(ctx.tenantId, "x") : null;
  await deleteTenantSocialConnection(ctx.tenantId, "x");
  const { result: revoked } = await revokeSocialConnection(ctx.tenantId, "x", tokens);
  return NextResponse.json({ ok: true, revoked });
}
