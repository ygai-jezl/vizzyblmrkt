import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { researchPlanBlog } from "@/lib/content/blog/hubActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/** Research runs web searches and opens the pages they return: keep it bounded per tenant. */
const RESEARCH_LIMIT = { prefix: "blog_research", burstLimit: 4, hourlyLimit: 30 };

/**
 * Research a blog plan's brief — the questions buyers ask, the brand's own pages to link
 * to, and third-party sources checked on the page — and save it on the plan. Reads the
 * PERSISTED plan (the canvas saves the operator's brief first). A person's rows in the
 * brief are kept; research replaces only its own. FLAG-GATED (503 until
 * CREATE_BLOG_CITABLE_ENABLED).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (await isRateLimited(`tenant:${ctx.tenantId}`, RESEARCH_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const r = await researchPlanBlog(ctx, { workspace: ws, plan });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ brief: r.brief, searched: r.searched, found: r.found });
}
