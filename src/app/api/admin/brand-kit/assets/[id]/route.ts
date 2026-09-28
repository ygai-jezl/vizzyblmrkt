import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getBrandAsset, updateBrandAsset, deleteBrandAsset } from "@/lib/admin/brandAssets";
import { deleteBrandAssetBytes } from "@/lib/tenant/brandAssetStore";
import { isBrandAssetsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rename a brand asset — `{ title }`. FLAG-GATED, same-origin, tenant-scoped. Icons and
 * graphics only: an email header image (`category: "header"`) belongs to Email style, so it
 * answers 404 here, as it does to DELETE.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandAssetsEnabled()) {
    return NextResponse.json({ error: "brand_assets_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== "string") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const title = body.title.trim().slice(0, 200);
  if (!title) {
    return NextResponse.json(
      { error: "invalid_input", message: "Name can't be empty." },
      { status: 400 },
    );
  }
  const existing = await getBrandAsset(ctx, id);
  if (!existing || existing.category === "header") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const asset = await updateBrandAsset(ctx, id, { title });
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ asset });
}

/**
 * Delete a brand asset — both the Firestore row and the GCS bytes. Not an email header image
 * (404): those are deleted only through Email style's admin route, which first takes the image
 * off the saved style, so a member can't remove the banner emails use from here.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandAssetsEnabled()) {
    return NextResponse.json({ error: "brand_assets_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const asset = await getBrandAsset(ctx, id);
  if (!asset || asset.category === "header") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await deleteBrandAsset(ctx, id);
  await deleteBrandAssetBytes(ctx.tenantId, asset.category, asset.filename);
  return NextResponse.json({ ok: true });
}
