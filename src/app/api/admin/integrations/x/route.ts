import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { deleteTenantSocialConnection } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect the tenant's X account (removes the encrypted tokens). */
export async function DELETE(req: Request) {
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  await deleteTenantSocialConnection(ctx.tenantId, "x");
  return NextResponse.json({ ok: true });
}
