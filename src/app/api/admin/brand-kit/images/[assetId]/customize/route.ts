import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getImageAsset } from "@/lib/admin/brandKit";
import { customizeImageAsset } from "@/lib/agents/creative";
import { IMAGE_MODEL_SLUGS } from "@/lib/content/create/imageModels";
import { resolveImageModel } from "@/lib/agents/modelConfig";
import { isBrandKitEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ assetId: string }> };

const BodySchema = z.object({
  instruction: z.string().min(1).max(1000),
  /** Operator-selected image model slug (lite | full). Omit to use the surface default (full). */
  model: z.enum(IMAGE_MODEL_SLUGS).optional(),
});

const IMAGE_ERRORS: Record<string, string> = {
  image_model_unavailable: "The image model isn't available right now.",
  no_asset_bucket: "Image storage isn't configured.",
  store_failed: "Couldn't save the image — try again.",
  bad_type: "The model returned an unsupported image type.",
  too_large: "The generated image was too large.",
  prior_too_large: "The source image is too large to edit (max 7 MB).",
  prior_unreadable: "Couldn't load the source image — try again.",
  record_failed: "Couldn't save the new image to your library — try again.",
};

/**
 * Brand Kit "Customise": generate a NEW image from an existing one via Nano Banana 2
 * (image-to-image edit). Non-destructive — the source is untouched; the result is a new
 * asset with `parentAssetId` set. FLAG-GATED (503 until BRAND_KIT_ENABLED). The source is
 * loaded via the tenant-scoped repository, so it can only ever be this tenant's asset.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitEnabled()) {
    return NextResponse.json({ error: "brand_kit_disabled" }, { status: 503 });
  }

  const { assetId } = await params;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const source = await getImageAsset(ctx, assetId);
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await customizeImageAsset({
    tenantId: ctx.tenantId,
    region: ctx.region,
    source,
    instruction: parsed.data.instruction,
    imageModel: parsed.data.model ? resolveImageModel(parsed.data.model) : undefined,
  });

  if (!result.asset) {
    const status = result.reason === "prior_too_large" ? 400 : 502;
    return NextResponse.json(
      { error: result.reason, message: IMAGE_ERRORS[result.reason ?? ""] ?? "Customise failed." },
      { status },
    );
  }
  return NextResponse.json({ image: result.asset });
}
