import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { deleteTenantGitConnection } from "@/lib/tenant";
import { isGitProvider } from "@/lib/integrations/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect a git provider (delete the stored encrypted token). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { provider } = await params;
  if (!isGitProvider(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }
  await deleteTenantGitConnection(ctx.tenantId, provider);
  return NextResponse.json({ ok: true });
}
