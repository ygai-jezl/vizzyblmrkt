import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { storeBrandPdf, MAX_BRAND_PDF_BYTES } from "@/lib/tenant/brandAsset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: "That PDF is too large (max 14MB).",
  bad_type: "Only PDF files are accepted.",
  no_asset_bucket: "File storage isn't configured.",
  store_failed: "Upload failed — try again.",
};

/** Store a brand-guidelines PDF privately; returns its ref (extraction happens next). */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_BRAND_PDF_BYTES) {
    return NextResponse.json({ error: "too_large", message: UPLOAD_ERRORS.too_large }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeBrandPdf(ctx.tenantId, bytes);
  if (!stored.ok) {
    return NextResponse.json({ error: stored.reason, message: UPLOAD_ERRORS[stored.reason] }, { status: 400 });
  }
  return NextResponse.json({ pdfPath: stored.filename, pdfName: file.name.slice(0, 300) });
}
