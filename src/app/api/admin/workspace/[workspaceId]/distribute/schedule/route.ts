import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  verifyWorkspace,
  getContentPlan,
  updateContentPlanNode,
} from "@/lib/tenant/workspaceContent";
import {
  schedulePost,
  setPostSpintax,
  cancelScheduledPost,
  listScheduledPosts,
  SchedulePostConflictError,
} from "@/lib/distribute/scheduler";
import { ScheduledPostChannel } from "@/lib/types/scheduledPost";
import { validateSpintax, SPINTAX_MAX_SOURCE_CHARS } from "@/lib/distribute/spintax";
import { scorePPS } from "@/lib/distribute/pps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A year out is the furthest a post may be scheduled (mirrors broadcast scheduling). */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

const ScheduleSchema = z.object({
  contentPlanId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64),
  // Require an absolute instant: parseable AND carrying a timezone designator
  // (trailing Z or ±HH:MM). A tz-less local string would be read in the server's
  // timezone, silently shifting the publish time — reject it.
  scheduledAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "invalid datetime")
    .refine((s) => /([zZ]|[+-]\d{2}:?\d{2})$/.test(s.trim()), "missing timezone"),
  /** Optional recycling template; one variant is rendered at publish. */
  spintaxSource: z.string().max(SPINTAX_MAX_SOURCE_CHARS).nullable().optional(),
  /** LinkedIn only: post as a Company Page URN (urn:li:organization:{id}); the worker
   *  verifies the tenant administers it. Absent → post as the connected member. */
  linkedInAuthorUrn: z
    .string()
    .max(200)
    .regex(/^urn:li:organization:\d+$/, "invalid org urn")
    .nullable()
    .optional(),
});

const CancelSchema = z.object({
  contentPlanId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64),
});

const SpintaxPatchSchema = z.object({
  contentPlanId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64),
  spintaxSource: z.string().max(SPINTAX_MAX_SOURCE_CHARS).nullable().optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

/** Schedule (or re-time) an approved Create node onto the Distribute queue. */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = ScheduleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  const { contentPlanId, nodeId, scheduledAt: rawScheduledAt } = parsed.data;

  const whenMs = Date.parse(rawScheduledAt);
  const nowMs = Date.now();
  if (whenMs <= nowMs) {
    return NextResponse.json({ error: "must_be_future" }, { status: 400 });
  }
  if (whenMs > nowMs + MAX_SCHEDULE_AHEAD_MS) {
    return NextResponse.json({ error: "too_far_ahead" }, { status: 400 });
  }
  // Normalise to an ISO instant so display + the queued post agree exactly.
  const scheduledAt = new Date(whenMs).toISOString();

  const plan = await getContentPlan(ctx, workspaceId, contentPlanId);
  if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  // Only a node with real, generated copy can be scheduled.
  if (node.status !== "generated" && node.status !== "approved") {
    return NextResponse.json({ error: "node_not_ready" }, { status: 409 });
  }
  if (!node.body.trim()) {
    return NextResponse.json({ error: "node_empty" }, { status: 409 });
  }
  // The node's channel must be a real, publishable Distribute channel.
  const channel = ScheduledPostChannel.safeParse(node.channel);
  if (!channel.success) {
    return NextResponse.json({ error: "channel_not_publishable" }, { status: 409 });
  }

  // Optional recycling template — reject a malformed one up front (blank → none).
  const spintaxSource = parsed.data.spintaxSource?.trim() ? parsed.data.spintaxSource : null;
  if (spintaxSource) {
    const v = validateSpintax(spintaxSource);
    if (!v.ok) {
      return NextResponse.json({ error: "invalid_spintax", reason: v.error }, { status: 400 });
    }
  }

  try {
    const { post } = await schedulePost(ctx, {
      workspaceId,
      contentPlanId,
      nodeId,
      channel: channel.data,
      format: node.format ?? null,
      body: node.body,
      spintaxSource,
      // Re-check the score from the copy at enqueue (matches the live preview gauge).
      pps: scorePPS(node.body, channel.data),
      // "Post as Page" only applies to LinkedIn; the worker verifies the tenant admins it.
      linkedInAuthorUrn: channel.data === "linkedin" ? (parsed.data.linkedInAuthorUrn ?? null) : null,
      // Carry the node's on-brand image (+ its prompt as alt text) so the worker can
      // attach it at publish (LinkedIn).
      imageAssetRef: node.imageAssetRef ?? null,
      imageAltText: node.imagePrompt ?? null,
      scheduledAt,
    });
    // Reflect the schedule back onto the source node so the canvas shows it.
    // Best-effort: the queued post is the source of truth for publishing (and is
    // listed in the Distribute tab), so a failed reflection must be observable —
    // log it rather than let the canvas silently diverge from the queue.
    await updateContentPlanNode(ctx, workspaceId, contentPlanId, nodeId, {
      scheduledAt,
    }).catch((err) => {
      console.warn(
        `[distribute] node schedule-reflection failed ${workspaceId}/${contentPlanId}/${nodeId}: ${
          err instanceof Error ? err.message : "error"
        }`,
      );
    });
    return NextResponse.json({ ok: true, status: "scheduled", post });
  } catch (err) {
    if (err instanceof SchedulePostConflictError) {
      return NextResponse.json({ error: err.reason }, { status: 409 });
    }
    throw err;
  }
}

/** List the workspace's scheduled posts (soonest first). */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const posts = await listScheduledPosts(ctx, workspaceId);
  return NextResponse.json({ posts });
}

/** Cancel a scheduled post (before the worker claims it) and clear the node's time. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = CancelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { contentPlanId, nodeId } = parsed.data;

  const cancelled = await cancelScheduledPost(ctx, workspaceId, contentPlanId, nodeId);
  if (!cancelled) {
    return NextResponse.json({ error: "already_publishing" }, { status: 409 });
  }
  await updateContentPlanNode(ctx, workspaceId, contentPlanId, nodeId, {
    scheduledAt: null,
  }).catch((err) => {
    console.warn(
      `[distribute] node cancel-reflection failed ${workspaceId}/${contentPlanId}/${nodeId}: ${
        err instanceof Error ? err.message : "error"
      }`,
    );
  });
  return NextResponse.json({ ok: true, status: "cancelled" });
}

/**
 * Update only a post's spintax template — no reschedule, so it can't hit the
 * must_be_future guard on an overdue-but-pending post, and it never resets a
 * failed post's status/retry state (unlike the schedule re-arm path).
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = SpintaxPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { contentPlanId, nodeId } = parsed.data;
  const spintaxSource = parsed.data.spintaxSource?.trim() ? parsed.data.spintaxSource : null;
  if (spintaxSource) {
    const v = validateSpintax(spintaxSource);
    if (!v.ok) {
      return NextResponse.json({ error: "invalid_spintax", reason: v.error }, { status: 400 });
    }
  }
  try {
    const { post } = await setPostSpintax(ctx, workspaceId, contentPlanId, nodeId, spintaxSource);
    return NextResponse.json({ ok: true, post });
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
