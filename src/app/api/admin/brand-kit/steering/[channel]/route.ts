import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isContentSteeringEnabled } from "@/lib/content/brandKit";
import { revertToVersion, resumeLearning } from "@/lib/distribute/feedback/patterns";
import { STEERING_CHANNELS } from "@/lib/distribute/feedback/steeringState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ channel: string }> };

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revert"), toVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("resume") }),
]);

/**
 * Content Steering — course-correct a channel's learned directive:
 *  • revert → pin the live directive to a past version + FREEZE auto-promotion;
 *  • resume → un-freeze so the loop resumes auto-promoting.
 * Tenant-scoped, same-origin, FLAG-GATED (503 until CONTENT_STEERING_ENABLED).
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isContentSteeringEnabled()) {
    return NextResponse.json({ error: "content_steering_disabled" }, { status: 503 });
  }

  const { channel } = await params;
  if (!(STEERING_CHANNELS as readonly string[]).includes(channel)) {
    return NextResponse.json({ error: "invalid_channel" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  if (parsed.data.action === "revert") {
    const res = await revertToVersion(ctx, channel, parsed.data.toVersion);
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 404 });
    return NextResponse.json({ ok: true });
  }
  await resumeLearning(ctx, channel);
  return NextResponse.json({ ok: true });
}
