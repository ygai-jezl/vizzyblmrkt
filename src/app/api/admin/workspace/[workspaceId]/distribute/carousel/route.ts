import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { verifyWorkspace, getContentPlan } from "@/lib/tenant/workspaceContent";
import { buildCarousel, isCarouselEnabled } from "@/lib/distribute/carousel/build";
import {
  getEditablePost,
  setPostCarousel,
  SchedulePostConflictError,
} from "@/lib/distribute/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BuildSchema = z.object({
  contentPlanId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * Build a carousel (Gemini slide images → private bucket) for a scheduled post and
 * attach the slide refs to it. FLAG-GATED: 503 until DISTRIBUTE_CAROUSEL_ENABLED
 * (+ the Vertex image model + asset bucket) are provisioned.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isCarouselEnabled()) {
    return NextResponse.json({ error: "carousel_disabled" }, { status: 503 });
  }

  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = BuildSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { contentPlanId, nodeId } = parsed.data;

  const plan = await getContentPlan(ctx, workspaceId, contentPlanId);
  if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node || !node.body.trim()) {
    return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  }

  // Fail FAST: don't spend N image-gen calls + bucket writes if the post isn't
  // attachable (missing / already publishing) — that would orphan the whole set.
  try {
    await getEditablePost(ctx, workspaceId, contentPlanId, nodeId);
  } catch (err) {
    if (err instanceof SchedulePostConflictError) {
      return NextResponse.json(
        { error: err.reason },
        { status: err.reason === "post_not_found" ? 404 : 409 },
      );
    }
    throw err;
  }

  const built = await buildCarousel(ctx, workspaceId, node.body);
  if (!built.ok) {
    const status =
      built.reason === "no_slides"
        ? 409
        : built.reason === "store_failed"
          ? 503 // usually an unprovisioned bucket → server misconfig, not a bad gateway
          : 502; // generation_failed (or a mid-request flag flip)
    return NextResponse.json({ error: built.reason }, { status });
  }

  try {
    const { post } = await setPostCarousel(
      ctx,
      workspaceId,
      contentPlanId,
      nodeId,
      built.slides.map((s) => s.filename),
    );
    return NextResponse.json({ ok: true, post, slides: built.slides, truncated: built.truncated });
  } catch (err) {
    if (err instanceof SchedulePostConflictError) {
      return NextResponse.json(
        { error: err.reason },
        { status: err.reason === "post_not_found" ? 404 : 409 },
      );
    }
    throw err;
  }
}
