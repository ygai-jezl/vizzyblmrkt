import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import {
  storeWorkspaceImage,
  MAX_SCREENSHOT_BYTES,
  isAllowedScreenshotType,
} from "@/lib/workspace/assetStore";
import { isSocialImageEnabled, isSocialImageChannel } from "@/lib/content/create/socialImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string; nodeId: string }> };

/**
 * Upload an image (PNG / JPG / WebP) as a social post node's image → private workspace
 * asset. The manual alternative to AI generation; returns the asset FILENAME (the inspector
 * applies it via onUpdate and the canvas Save persists it). FLAG-GATED (503 until
 * CREATE_SOCIAL_IMAGE_ENABLED); needs no Vertex/model access. Type is trusted from the
 * magic-byte sniff inside storeWorkspaceImage, not the client content-type.
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

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: "Image is too large (max 8 MB)." },
      { status: 413 },
    );
  }
  if (!isAllowedScreenshotType(file.type)) {
    return NextResponse.json(
      { error: "bad_type", message: "Upload a PNG, JPG or WebP image." },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeWorkspaceImage(ctx.tenantId, workspaceId, bytes, file.type);
  if (!stored.ok) {
    // The store re-checks via a magic-byte sniff, so a file the OS mislabels image/*
    // (or a corrupt/truncated one) is caught HERE — surface it as an actionable client
    // error ("the file is the problem"), not a transient "try again" retry.
    if (stored.reason === "bad_type" || stored.reason === "too_large") {
      const message =
        stored.reason === "too_large"
          ? "Image is too large (max 8 MB)."
          : "Upload a PNG, JPG or WebP image.";
      return NextResponse.json({ error: stored.reason, message }, { status: stored.reason === "too_large" ? 413 : 400 });
    }
    return NextResponse.json(
      { error: stored.reason, message: "Couldn't save the image — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }
  return NextResponse.json({ imageAssetRef: stored.filename });
}
