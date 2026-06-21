import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { enqueueContactEnrich } from "@/lib/crm/enrichmentQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manually (re)enrich a company. This is a cost-multiplying, explicit admin
 * action (Gemini spend), so it requires the admin role (§H3) — like launch
 * archive/delete. The worker still enforces the per-tenant daily cap + region
 * gate, so a re-enrich can never bypass those controls.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { companyId } = await params;
  const company = await forTenant(ctx).companies.getById(companyId);
  if (!company) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Reset to pending so the worker re-runs (and the UI shows the in-flight state).
  await forTenant(ctx).companies.update(companyId, {
    enrichmentStatus: "pending",
    lastError: null,
  });

  // Find a campaignId to tag the job (any associated contact's, else "manual").
  const linked = await forTenant(ctx).contacts.find({
    where: [["companyId", "==", companyId]],
    limit: 1,
  });
  const campaignId = linked[0]?.campaignIds[0] ?? "manual";
  const dedupeKey = `enrich:company:${companyId}`;

  // Enqueue; if a prior enrich job is parked under this key, resurrect it (mirror
  // the broadcast resurrection trick) so the re-enrich actually runs.
  const result = await enqueueContactEnrich(ctx, {
    companyId,
    domain: company.domain,
    campaignId,
  });
  if (result === "duplicate") {
    await forTenant(ctx)
      .emailJobs.update(dedupeKey, {
        status: "pending",
        scheduledAt: new Date().toISOString(),
        attempts: 0,
        claimedAt: null,
        lastError: null,
        processedAt: null,
      })
      .catch(() => {});
  }
  return NextResponse.json({ ok: true, status: "pending" });
}
