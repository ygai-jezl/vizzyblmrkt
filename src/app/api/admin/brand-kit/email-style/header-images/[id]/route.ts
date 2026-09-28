import { NextResponse } from "next/server";
import { deleteBrandAsset, getBrandAsset } from "@/lib/admin/brandAssets";
import { deleteBrandAssetBytes } from "@/lib/tenant/brandAssetStore";
import { clearTenantEmailStyleHeaderImage } from "@/lib/tenant/control";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";
import { isEmailHeaderOptionsEnabled } from "@/lib/email/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete an email header image (Brand › Email style): the row and the bytes. Admin-only (a
 * member can't delete any of them), and only with EMAIL_HEADER_OPTIONS_ENABLED. If the saved
 * style uses it, the style goes back to its header colour first, so a failure leaves the image
 * in place rather than a style pointing at nothing; `cleared` says whether it did. It clears
 * again once the row is gone, for a Save that checked the image before the delete but wrote it
 * after the first clear (the Save checks again after writing, which covers the other orders).
 * Copies that inboxes or browsers have cached may keep showing for a while (the route is cached
 * as immutable).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  const { ctx } = g;
  if (!isEmailHeaderOptionsEnabled()) {
    return NextResponse.json({ error: "header_options_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const image = await getBrandAsset(ctx, id);
  if (!image || image.category !== "header") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cleared = await clearTenantEmailStyleHeaderImage(ctx.tenantId, image.filename);
  await deleteBrandAsset(ctx, id);
  const clearedAfter = await clearTenantEmailStyleHeaderImage(ctx.tenantId, image.filename);
  await deleteBrandAssetBytes(ctx.tenantId, "header", image.filename);
  return NextResponse.json({ ok: true, cleared: cleared || clearedAfter });
}
