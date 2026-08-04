import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import { BrandAssetCategorySchema, type BrandAsset } from "@/lib/types/brandAsset";
import { isBrandAssetsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List the tenant's uploaded brand assets for a category — `?category=icon|graphic`. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandAssetsEnabled()) {
    return NextResponse.json({ error: "brand_assets_disabled" }, { status: 503 });
  }
  const category = BrandAssetCategorySchema.safeParse(
    new URL(req.url).searchParams.get("category"),
  );
  if (!category.success) return NextResponse.json({ error: "invalid_category" }, { status: 400 });

  let assets: BrandAsset[] = [];
  try {
    assets = await listBrandAssets(ctx, category.data);
  } catch (err) {
    console.error("[brand-kit] assets list failed (index building?)", err);
    assets = [];
  }
  return NextResponse.json({ assets });
}
