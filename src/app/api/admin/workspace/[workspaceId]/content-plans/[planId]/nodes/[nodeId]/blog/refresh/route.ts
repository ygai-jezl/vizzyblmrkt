import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTOPILOT_RUNNING, autopilotHolds } from "@/lib/autopilot/planLock";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { advanceReview, readReview, startReview, stopReview } from "@/lib/content/blog/refreshReview";
import { applyReview, dismissReview } from "@/lib/content/blog/refreshPropose";
import { mayStartReview } from "@/lib/content/blog/refreshGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/** A review searches the web and calls the model: bounded per brand. */
const START_LIMIT = { prefix: "blog_refresh", burstLimit: 3, hourlyLimit: 20 };
/** How long a step from the open article may take (the slowest is research). */
const PAGE_STEP_MS = 85_000;

const BodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("step") }),
  z.strictObject({ action: z.literal("stop") }),
  z.strictObject({ action: z.literal("dismiss") }),
  z.strictObject({ action: z.literal("apply"), ids: z.array(z.string().regex(/^p\d{1,2}$/)).min(1).max(8) }),
]);

/**
 * A live blog article's refresh review (BLOG_REFRESH_ENABLED). GET reads it; POST starts one,
 * moves it a step while the article is open, stops it, applies the ticked changes, or dismisses
 * them all. Members and admins alike, as for any edit to an article.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  if (!isBlogRefreshEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  const review = await readReview(ctx, planId);
  if (!review || review.workspaceId !== workspaceId) return NextResponse.json({ review: null }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ review }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBlogRefreshEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = parsed.data;

  if (body.action === "stop") return NextResponse.json({ review: await stopReview(ctx, planId) });
  if (body.action === "step") {
    const review = (await advanceReview(ctx, planId, { deadlineMs: Date.now() + PAGE_STEP_MS })) ?? (await readReview(ctx, planId));
    return NextResponse.json({ review });
  }
  if (body.action === "dismiss") {
    const r = await dismissReview(ctx, { workspaceId, planId });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ review: r.review, node: r.node });
  }
  // The article autopilot is writing it: nothing starts or saves over the run until it ends.
  if (autopilotHolds(plan)) return NextResponse.json(AUTOPILOT_RUNNING, { status: 409 });
  if (body.action === "apply") {
    const r = await applyReview(ctx, { workspace: { id: ws.id, name: ws.name, audience: ws.audience ?? null }, planId, ids: body.ids });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ node: r.node, brief: r.brief, applied: r.applied, skipped: r.skipped, real: r.real, checked: r.checked, review: r.review });
  }

  // Start: the brand may (its grant and this month's cap), and not too many at once.
  const may = await mayStartReview(ctx);
  if (!may.ok) return NextResponse.json({ error: may.error }, { status: may.status });
  if (await isRateLimited(`tenant:${ctx.tenantId}`, START_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const r = await startReview(ctx, { plan, nodeId, by: "person" });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ review: r.review, started: r.started });
}
