import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, getTenantById } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { generateEmailBlockImage } from "@/lib/agents/creative";
import { assembleBrandContext, resolveBrandVoiceText } from "@/lib/content/create/brandContext";
import { htmlToText } from "@/lib/email/emailRender";
import { findCopyBlockIndex } from "@/lib/types/emailLayout";
import { platformOrigin } from "@/lib/platform/origin";
import { originFromHeaders } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

const BodySchema = z.object({
  brief: z.string().min(1).max(1000),
  blockId: z.string().max(64).optional(),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
};

/** Generate an ON-BRAND image for an email layout block; returns its public URL. */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const tenant = await getTenantById(ctx.tenantId);
  // Copy excerpt for image context: the layout's copy block (else the node body).
  const copyIdx = node.layout ? findCopyBlockIndex(node.layout) : -1;
  const copyBlock = copyIdx >= 0 ? node.layout!.blocks[copyIdx] : undefined;
  const copyHtml = copyBlock && copyBlock.kind === "text" ? copyBlock.html : node.body;

  const result = await generateEmailBlockImage({
    tenantId: ctx.tenantId,
    ownerId: workspaceId,
    brief: parsed.data.brief,
    subject: node.subject ?? "",
    copyExcerpt: htmlToText(copyHtml || ""),
    brandContext: assembleBrandContext({
      brandVoice: resolveBrandVoiceText({
        tenantBrandVoice: tenant?.brandVoice,
        workspaceBrandVoice: ws.brandVoice,
      }),
      audience: ws.audience ?? null,
      brandKit: tenant?.brandKit ?? null,
      layout: node.layout ?? null,
    }),
    baseUrl: platformOrigin() || originFromHeaders(req.headers),
  });

  if (!result.imageUrl) {
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Image generation failed." },
      { status: 502 },
    );
  }
  return NextResponse.json({ imageUrl: result.imageUrl });
}
