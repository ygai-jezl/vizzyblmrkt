import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getBrandFont, updateBrandFont, deleteBrandFont } from "@/lib/admin/brandFonts";
import { deleteBrandFontBytes } from "@/lib/tenant/brandFontStore";
import { isBrandFontsEnabled } from "@/lib/content/brandKit";
import { sanitizeFontFamily } from "@/lib/content/fonts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rename an uploaded font — `{ title?, family? }`. FLAG-GATED, same-origin, tenant-scoped. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandFontsEnabled()) {
    return NextResponse.json({ error: "brand_fonts_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; family?: unknown };

  const patch: { title?: string; family?: string } = {};
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200);
  // Family is echoed into a client @font-face rule (dangerouslySetInnerHTML) — safe-charset only.
  if (typeof body.family === "string") patch.family = sanitizeFontFamily(body.family);
  if ((patch.title !== undefined && !patch.title) || (patch.family !== undefined && !patch.family)) {
    return NextResponse.json(
      { error: "invalid_input", message: "Name can't be empty." },
      { status: 400 },
    );
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const font = await updateBrandFont(ctx, id, patch);
  if (!font) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ font });
}

/** Delete an uploaded font — both the Firestore row and the GCS bytes. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandFontsEnabled()) {
    return NextResponse.json({ error: "brand_fonts_disabled" }, { status: 503 });
  }
  const { id } = await params;
  const font = await getBrandFont(ctx, id);
  if (!font) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await deleteBrandFont(ctx, id);
  await deleteBrandFontBytes(ctx.tenantId, font.filename);
  return NextResponse.json({ ok: true });
}
