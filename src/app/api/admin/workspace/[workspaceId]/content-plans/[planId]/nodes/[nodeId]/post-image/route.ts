import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { generateSocialPostImage } from "@/lib/agents/creative";
import { assembleBrandContext, resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import {
  isSocialImageEnabled,
  isSocialImageChannel,
  SOCIAL_IMAGE_STYLE_IDS,
} from "@/lib/content/create/socialImage";
import { IMAGE_MODEL_SLUGS } from "@/lib/content/create/imageModels";
import { resolveImageModel } from "@/lib/agents/modelConfig";
import { htmlToText } from "@/lib/email/emailRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

const BodySchema = z.object({
  brief: z.string().min(1).max(1000),
  aspect: z.enum(["1:1", "4:5", "1.91:1"]),
  style: z.enum(SOCIAL_IMAGE_STYLE_IDS),
  /** Brand-style loop override (default true = apply learned style + references). */
  useBrandStyle: z.boolean().optional(),
  /** Operator-selected image model slug (lite | full). Omit to use the surface default. */
  model: z.enum(IMAGE_MODEL_SLUGS).optional(),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "The model returned an unsupported image type.",
  too_large: "The generated image was too large.",
};

/**
 * Generate an ON-BRAND image for a social post node (linkedin/x/instagram), STORE it as a
 * private workspace asset, and PERSIST its filename (+ aspect + prompt) onto the node —
 * mirroring the text generate route so the image survives a reload without a manual canvas
 * Save. Returns the persisted ref; the inspector also applies it via onUpdate for an instant
 * thumbnail. FLAG-GATED (503 until CREATE_SOCIAL_IMAGE_ENABLED). Grounded server-side by the
 * workspace + Brand Kit.
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
  const useBrandStyle = parsed.data.useBrandStyle !== false;
  const result = await generateSocialPostImage({
    tenantId: ctx.tenantId,
    workspaceId,
    channel: node.channel,
    brief: parsed.data.brief,
    aspect: parsed.data.aspect,
    style: parsed.data.style,
    copyExcerpt: htmlToText(node.body || ""),
    // Register the generated image in the Brand Kit library (best-effort).
    region: ctx.region,
    planId,
    nodeId,
    useBrandStyle,
    imageModel: parsed.data.model ? resolveImageModel(parsed.data.model) : undefined,
    brandContext: assembleBrandContext({
      brandVoice: resolveBrandVoiceText({
        tenantBrandVoice: tenant?.brandVoice,
        workspaceBrandVoice: ws.brandVoice,
      }),
      audience: ws.audience ?? null,
      brandKit: tenant?.brandKit ?? null,
      typography: tenant?.brandTypography ?? null,
      // Suppress the learned text directive too when the override is off (explicit null);
      // otherwise fall back to the kit's learned style (automatic apply).
      learnedImageStyle: useBrandStyle ? undefined : null,
    }),
  });

  if (!result.imageAssetRef) {
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Image generation failed." },
      { status: 502 },
    );
  }

  // Persist the ref onto the node (transactional per-node write) so it's durable the moment
  // it's generated — no dependence on the operator clicking Save. A later whole-graph Save
  // re-writes the same values from local state.
  const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
    imageAssetRef: result.imageAssetRef,
    imageAspect: parsed.data.aspect,
    imagePrompt: result.imagePrompt ?? null,
  });
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  return NextResponse.json({ imageAssetRef: updated.imageAssetRef, imagePrompt: updated.imagePrompt ?? null });
}

/**
 * Clear a social post node's image — unset the node's image fields durably (so Remove
 * survives a reload, like generate). The inspector also clears local state via onUpdate.
 * We deliberately do NOT delete the stored asset: a scheduled Distribute post copies the
 * node's imageAssetRef by FILENAME (scheduler reads it at publish time), and Regenerate
 * likewise orphans-without-deleting — so the asset must outlive the node reference.
 * FLAG-GATED to match generation.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
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

  const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
    imageAssetRef: null,
    imageAspect: null,
    imagePrompt: null,
  });
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
