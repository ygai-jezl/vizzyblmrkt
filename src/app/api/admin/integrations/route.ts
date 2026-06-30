import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { PROVIDERS, isProviderConfigured, type GitProvider } from "@/lib/integrations/providers";
import { isGitCryptoConfigured } from "@/lib/integrations/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-provider git connection status for the current tenant (never the token). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  const conns = (tenant?.gitConnections ?? {}) as Partial<
    Record<GitProvider, { accountLogin?: string | null; connectedAt?: string | null }>
  >;
  const cryptoOk = isGitCryptoConfigured();

  const providers: Record<string, unknown> = {};
  (Object.keys(PROVIDERS) as GitProvider[]).forEach((p) => {
    const c = conns[p];
    providers[p] = {
      label: PROVIDERS[p].label,
      configured: isProviderConfigured(p) && cryptoOk,
      connected: Boolean(c),
      accountLogin: c?.accountLogin ?? null,
      connectedAt: c?.connectedAt ?? null,
    };
  });
  return NextResponse.json({ providers });
}
