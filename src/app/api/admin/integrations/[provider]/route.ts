import { NextResponse } from "next/server";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { deleteTenantGitConnection } from "@/lib/tenant";
import { isGitProvider } from "@/lib/integrations/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect a git provider (delete the stored encrypted token). Admins only. */
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
  await deleteTenantGitConnection(ctx.tenantId, provider);
  return NextResponse.json({ ok: true });
}
