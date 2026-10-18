import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isSeenOn, matchPlanSeen } from "@/lib/content/blog/hubActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/** A meaning search and one or two short model calls a run: bounded per tenant. */
const SEEN_LIMIT = { prefix: "blog_seen", burstLimit: 6, hourlyLimit: 60 };

/**
 * Find the brand's notes (What we've seen) that match a blog article's question strongly, put
 * them on its brief, and, when none does, three questions its team could answer. Reads the
 * PERSISTED plan (the canvas saves first). Gated by BRAND_NOTES_ENABLED and
 * CREATE_BLOG_EDITORIAL_ENABLED (503 otherwise).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSeenOn()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (await isRateLimited(`tenant:${ctx.tenantId}`, SEEN_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const r = await matchPlanSeen(ctx, { workspace: ws, plan });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ seen: r.seen });
}
