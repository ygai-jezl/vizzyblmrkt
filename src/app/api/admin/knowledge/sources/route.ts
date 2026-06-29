import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List ingestion tickets (knowledge "sources"), optionally for one campaign.
 * Ordered newest-first in memory to avoid a composite (tenantId, campaignId,
 * createdAt) index — the per-tenant ticket count is small and operational.
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const campaignId = new URL(req.url).searchParams.get("campaignId");
  const tickets = await forTenant(ctx).ingestionTickets.find({
    where: campaignId ? [["campaignId", "==", campaignId]] : [],
    limit: 200,
  });
  tickets.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return NextResponse.json({ tickets });
}
