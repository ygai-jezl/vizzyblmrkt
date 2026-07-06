import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { generateSocialPostImage } from "@/lib/agents/creative";
import { assembleBrandContext } from "@/lib/content/create/brandContext";
import {
  isSocialImageEnabled,
  isSocialImageChannel,
  SOCIAL_IMAGE_STYLE_IDS,
} from "@/lib/content/create/socialImage";
import { htmlToText } from "@/lib/email/emailRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

const BodySchema = z.object({
  brief: z.string().min(1).max(1000),
  aspect: z.enum(["1:1", "4:5", "1.91:1"]),
  style: z.enum(SOCIAL_IMAGE_STYLE_IDS),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "The model returned an unsupported image type.",
  too_large: "The generated image was too large.",
};

/**
 * Generate an ON-BRAND image for a social post node (linkedin/x/instagram) and return
 * its workspace-asset FILENAME. Does NOT persist — the inspector applies it via
 * onUpdate and the whole-graph canvas Save persists it. FLAG-GATED (503 until
 * CREATE_SOCIAL_IMAGE_ENABLED). Grounded server-side by the workspace + Brand Kit.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isSocialImageEnabled()) {
    return NextResponse.json({ error: "social_image_disabled" }, { status: 503 });
  }

  const { workspaceId, planId, nodeId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  if (!isSocialImageChannel(node.channel)) {
    return NextResponse.json({ error: "unsupported_channel" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const tenant = await getTenantById(ctx.tenantId);
  const result = await generateSocialPostImage({
    tenantId: ctx.tenantId,
    workspaceId,
    channel: node.channel,
    brief: parsed.data.brief,
    aspect: parsed.data.aspect,
    style: parsed.data.style,
    copyExcerpt: htmlToText(node.body || ""),
    brandContext: assembleBrandContext({
      brandVoice: ws.brandVoice ?? null,
      audience: ws.audience ?? null,
      brandKit: tenant?.brandKit ?? null,
    }),
  });

  if (!result.imageAssetRef) {
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Image generation failed." },
      { status: 502 },
    );
  }
  return NextResponse.json({ imageAssetRef: result.imageAssetRef, imagePrompt: result.imagePrompt });
}
