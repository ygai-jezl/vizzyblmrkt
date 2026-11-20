import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { deleteTenantSocialConnection } from "@/lib/tenant";
import { isConnectorRevokeEnabled } from "@/lib/integrations/flags";
import { revokeSocialConnection } from "@/lib/social/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect the tenant's LinkedIn account (removes the encrypted tokens).
 * LinkedIn is never revoked at LinkedIn (src/lib/social/revoke.ts says why), so with
 * CONNECTOR_REVOKE_ENABLED on the response only adds `revoked: "skipped"`.
 */
export async function DELETE(req: Request) {
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  await deleteTenantSocialConnection(ctx.tenantId, "linkedin");
  if (!isConnectorRevokeEnabled()) return NextResponse.json({ ok: true });
  const { result: revoked } = await revokeSocialConnection(ctx.tenantId, "linkedin", null);
  return NextResponse.json({ ok: true, revoked });
}
