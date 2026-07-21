import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  storeWorkspaceImage,
  MAX_SCREENSHOT_BYTES,
  isAllowedScreenshotType,
} from "@/lib/workspace/assetStore";
import { recordImageAsset } from "@/lib/admin/brandKit";
import { refreshExemplarStyle } from "@/lib/content/create/styleProfile";
import { isBrandKitEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SEED_RATING = 9;

/**
 * COLD START: upload an existing on-brand image (PNG / JPG / WebP) as a brand exemplar,
 * so the style engine has something to learn from before anything's been generated. The
 * upload is stored as a private workspace asset, recorded in the registry as an up-voted
 * exemplar, and run straight through the L1 style extraction (fire-and-forget).
 *
 * Bytes must live under a REAL workspace the tenant owns — the authenticated asset proxy
 * re-validates workspace ownership (verifyWorkspace), so a synthetic partition would 404
 * the thumbnail. We therefore attach the seed to the tenant's first workspace purely as a
 * storage partition; the registry row is tenant-wide as usual. FLAG-GATED (BRAND_KIT_ENABLED).
 * Type is trusted from the magic-byte sniff inside storeWorkspaceImage, not the client.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitEnabled()) {
    return NextResponse.json({ error: "brand_kit_disabled" }, { status: 503 });
  }

  // A real, owned workspace to store the bytes under (any one — it's just the GCS/proxy
  // partition; the seed is tenant-wide via the registry).
  const workspaces = await forTenant(ctx).workspaces.find({ limit: 1 });
  const workspaceId = workspaces[0]?.id;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "no_workspace", message: "Create a workspace first, then add brand images." },
      { status: 409 },
    );
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

  const ratingRaw = Number.parseInt(String(form?.get("rating") ?? ""), 10);
  const rating = Number.isFinite(ratingRaw)
    ? Math.min(Math.max(ratingRaw, 1), 10)
    : DEFAULT_SEED_RATING;

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeWorkspaceImage(ctx.tenantId, workspaceId, bytes, file.type);
  if (!stored.ok) {
    if (stored.reason === "bad_type" || stored.reason === "too_large") {
      const message =
        stored.reason === "too_large"
          ? "Image is too large (max 8 MB)."
          : "Upload a PNG, JPG or WebP image.";
      return NextResponse.json(
        { error: stored.reason, message },
        { status: stored.reason === "too_large" ? 413 : 400 },
      );
    }
    return NextResponse.json(
      { error: stored.reason, message: "Couldn't save the image — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }

  let asset;
  try {
    asset = await recordImageAsset(
      { tenantId: ctx.tenantId, region: ctx.region },
      {
        workspaceId,
        filename: stored.filename,
        mimeType: file.type,
        kind: "upload",
        title: "Brand reference",
        brief: "Uploaded brand reference image",
        source: null,
        parentAssetId: null,
        byteSize: bytes.length,
        brandVote: "up",
        brandRating: rating,
        brandVoteSetAt: new Date().toISOString(),
      },
    );
  } catch (err) {
    console.warn("[brandKit] seed upload record failed:", err);
    return NextResponse.json(
      { error: "record_failed", message: "Couldn't save the image to your library — try again." },
      { status: 502 },
    );
  }

  // Learn from it INLINE (extract style + re-synthesize). Awaited, not fire-and-forget:
  // Cloud Run throttles CPU after the response, so a background task would often never run
  // and the seed would never teach the engine. Fail-soft, so it can't fail the upload; the
  // asset is already recorded above. No-ops instantly when the loop flag is off.
  await refreshExemplarStyle(ctx, asset.id).catch(() => {});

  return NextResponse.json({ image: asset });
}
