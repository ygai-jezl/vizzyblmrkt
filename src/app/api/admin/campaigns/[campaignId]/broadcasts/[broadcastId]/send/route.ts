import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { enqueueBroadcast, processEmailJobs } from "@/lib/email/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Queue a broadcast for delivery and kick the worker inline so it goes out now
 * (no cron needed in dev). Idempotent: re-sending an already-sent broadcast is a
 * no-op.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string; broadcastId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, broadcastId } = await params;
  const broadcast = await forTenant(ctx).broadcasts.getById(broadcastId);
  if (!broadcast || broadcast.campaignId !== campaignId) {
    return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
  }
  if (broadcast.status === "sent") {
    return NextResponse.json({ ok: true, status: "sent" });
  }

  await forTenant(ctx).broadcasts.update(broadcastId, {
    status: "queued",
    lastError: null,
  });
  await enqueueBroadcast(ctx, broadcastId, campaignId);
  const result = await processEmailJobs(ctx);

  const after = await forTenant(ctx).broadcasts.getById(broadcastId);
  return NextResponse.json({
    ok: true,
    status: after?.status ?? "queued",
    lastError: after?.lastError ?? null,
    result,
  });
}
