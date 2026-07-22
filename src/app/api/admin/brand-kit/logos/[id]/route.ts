import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getLogo, updateLogo, deleteLogo, setPrimaryLogo } from "@/lib/admin/brandLogos";
import { deleteBrandLogo } from "@/lib/tenant/brandLogo";
import { isBrandKitLogosEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rename (`title`) or set-primary a logo. Body: `{ title?: string; setPrimary?: true }`.
 * FLAG-GATED, same-origin only, tenant-scoped via getLogo/updateLogo/setPrimaryLogo.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitLogosEnabled()) {
    return NextResponse.json({ error: "brand_kit_logos_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; setPrimary?: unknown };

  if (body.setPrimary === true) {
    const logo = await setPrimaryLogo(ctx, id);
    if (!logo) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ logo });
  }
  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 200);
    if (!title) {
      return NextResponse.json(
        { error: "invalid_input", message: "Name can't be empty." },
        { status: 400 },
      );
    }
    const logo = await updateLogo(ctx, id, { title });
    if (!logo) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ logo });
  }
  return NextResponse.json({ error: "invalid_input" }, { status: 400 });
}

/**
 * Delete a logo — both the Firestore row and the GCS bytes. No primary reassignment needed:
 * getPrimaryLogo derives the newest logo as primary when none is explicitly flagged, so
 * deleting the primary self-heals on the next read (no index-dependent promotion write).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitLogosEnabled()) {
    return NextResponse.json({ error: "brand_kit_logos_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const logo = await getLogo(ctx, id);
  if (!logo) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await deleteLogo(ctx, id);
  await deleteBrandLogo(ctx.tenantId, logo.filename);
  return NextResponse.json({ ok: true });
}
