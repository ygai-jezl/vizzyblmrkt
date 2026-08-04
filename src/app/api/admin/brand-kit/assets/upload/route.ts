import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isAllowedScreenshotType } from "@/lib/workspace/assetStore";
import { storeBrandAsset, MAX_ASSET_BYTES } from "@/lib/tenant/brandAssetStore";
import {
  recordBrandAsset,
  countBrandAssetsUpTo,
  MAX_ASSETS_PER_CATEGORY,
} from "@/lib/admin/brandAssets";
import { BrandAssetCategorySchema } from "@/lib/types/brandAsset";
import { isBrandAssetsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload an ICON or GRAPHIC (PNG / JPG / WebP) into the tenant's brand-global asset library. The
 * `category` form field routes it to `brand/{tenantId}/{category}s/...` and a `brand_assets` row is
 * recorded. FLAG-GATED (BRAND_ASSETS_ENABLED). Same-origin only; type is trusted from the
 * magic-byte sniff inside storeBrandAsset, not the client. Raster-only so the bytes can be fed to
 * the image model as visual references.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandAssetsEnabled()) {
    return NextResponse.json({ error: "brand_assets_disabled" }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const category = BrandAssetCategorySchema.safeParse(form?.get("category"));
  if (!category.success) return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_ASSET_BYTES) {
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

  // Per-category cap from ONE index-free read (works while the composite index builds). A transient
  // read failure (null) skips the cap rather than blocking the upload.
  let existingCount: number | null = null;
  try {
    existingCount = await countBrandAssetsUpTo(ctx, category.data, MAX_ASSETS_PER_CATEGORY + 1);
  } catch {
    existingCount = null;
  }
  if (existingCount !== null && existingCount >= MAX_ASSETS_PER_CATEGORY) {
    return NextResponse.json(
      {
        error: "limit_reached",
        message: `You can store up to ${MAX_ASSETS_PER_CATEGORY} ${category.data}s. Delete one to add another.`,
      },
      { status: 409 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeBrandAsset(ctx.tenantId, category.data, bytes, file.type);
  if (!stored.ok) {
    if (stored.reason === "too_large") {
      return NextResponse.json(
        { error: stored.reason, message: "Image is too large (max 8 MB)." },
        { status: 413 },
      );
    }
    if (stored.reason === "bad_type") {
      return NextResponse.json(
        { error: stored.reason, message: "Upload a PNG, JPG or WebP image." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: stored.reason, message: "Couldn't save the asset — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }

  const rawName = typeof file.name === "string" ? file.name : "";
  const title = (rawName.split(/[/\\]/).pop() || category.data).slice(0, 200);

  let asset;
  try {
    asset = await recordBrandAsset(
      { tenantId: ctx.tenantId, region: ctx.region },
      {
        category: category.data,
        filename: stored.filename,
        mimeType: stored.mimeType,
        title,
        byteSize: bytes.length,
      },
    );
  } catch (err) {
    console.warn("[brandKit] asset upload record failed:", err);
    return NextResponse.json(
      { error: "record_failed", message: "Couldn't save the asset to your library — try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ asset });
}
