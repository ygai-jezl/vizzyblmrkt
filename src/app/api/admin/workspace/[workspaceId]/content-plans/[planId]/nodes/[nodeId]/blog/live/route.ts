import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { setArticleLive } from "@/lib/content/blog/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/** A check opens a page on the brand's site: keep it bounded per tenant. */
const CHECK_LIMIT = { prefix: "blog_live", burstLimit: 6, hourlyLimit: 60 };

const BodySchema = z.strictObject({ action: z.enum(["check", "mark", "clear"]) });

/**
 * Is a blog article live at its address? "check" opens the page and compares its title;
 * "mark" is a person saying it is; "clear" says it is not. Saved on the hub's meta, and on
 * the article's row on the brand map. FLAG-GATED (503 until BRAND_MAP_PAGES_ENABLED).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandMapPagesEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (parsed.data.action === "check" && (await isRateLimited(`tenant:${ctx.tenantId}`, CHECK_LIMIT))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const r = await setArticleLive(ctx, { workspaceId, plan, nodeId, action: parsed.data.action });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ node: r.node, check: r.check });
}
