import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getBrandAsset, updateBrandAsset, deleteBrandAsset } from "@/lib/admin/brandAssets";
import { deleteBrandAssetBytes } from "@/lib/tenant/brandAssetStore";
import { isBrandAssetsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rename a brand asset — `{ title }`. FLAG-GATED, same-origin, tenant-scoped. */
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
  const asset = await updateBrandAsset(ctx, id, { title });
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ asset });
}

/** Delete a brand asset — both the Firestore row and the GCS bytes. */
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
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await deleteBrandAsset(ctx, id);
  await deleteBrandAssetBytes(ctx.tenantId, asset.category, asset.filename);
  return NextResponse.json({ ok: true });
}
