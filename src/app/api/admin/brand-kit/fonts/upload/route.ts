import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { storeBrandFont, MAX_FONT_BYTES } from "@/lib/tenant/brandFontStore";
import { recordBrandFont, countBrandFontsUpTo, MAX_FONTS_PER_TENANT } from "@/lib/admin/brandFonts";
import { isBrandFontsEnabled } from "@/lib/content/brandKit";
import { sanitizeFontFamily } from "@/lib/content/fonts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strip the path + extension from an uploaded filename to a clean CSS family name. */
function familyFromName(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() || "").replace(/\.[^.]+$/, "");
  return base.replace(/[_-]+/g, " ").trim().slice(0, 80) || "Custom font";
}

/**
 * Upload a custom FONT FILE (WOFF2 / WOFF / TTF / OTF) into the tenant's brand-global font library.
 * Bytes go to the private bucket under `brand/{tenantId}/fonts/...` and a `brand_fonts` registry row
 * is recorded. FLAG-GATED (BRAND_FONTS_ENABLED). Same-origin only; type is trusted from the
 * magic-byte sniff inside storeBrandFont, not the client.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandFontsEnabled()) {
    return NextResponse.json({ error: "brand_fonts_disabled" }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_FONT_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: "Font file is too large (max 5 MB)." },
      { status: 413 },
    );
  }

  // Enforce the per-tenant cap from ONE index-free read (no orderBy → works while the composite
  // index builds). A transient read failure (null) skips the cap rather than blocking the upload.
  let existingCount: number | null = null;
  try {
    existingCount = await countBrandFontsUpTo(ctx, MAX_FONTS_PER_TENANT + 1);
  } catch {
    existingCount = null;
  }
  if (existingCount !== null && existingCount >= MAX_FONTS_PER_TENANT) {
    return NextResponse.json(
      {
        error: "limit_reached",
        message: `You can store up to ${MAX_FONTS_PER_TENANT} fonts. Delete one to add another.`,
      },
      { status: 409 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeBrandFont(ctx.tenantId, bytes);
  if (!stored.ok) {
    if (stored.reason === "too_large") {
      return NextResponse.json(
        { error: stored.reason, message: "Font file is too large (max 5 MB)." },
        { status: 413 },
      );
    }
    if (stored.reason === "bad_type") {
      return NextResponse.json(
        { error: stored.reason, message: "Upload a WOFF2, WOFF, TTF or OTF font file." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: stored.reason, message: "Couldn't save the font — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }

  const rawName = typeof file.name === "string" ? file.name : "";
  const formFamily = typeof form?.get("family") === "string" ? String(form.get("family")) : "";
  // Restrict to a safe charset — the family is echoed into a client @font-face rule injected via
  // dangerouslySetInnerHTML, so a raw newline/`<`/`{`/`;` must never survive to the stored value.
  const family = sanitizeFontFamily(formFamily || familyFromName(rawName)) || "Custom font";
  const title = (rawName.split(/[/\\]/).pop() || family).slice(0, 200);

  let font;
  try {
    font = await recordBrandFont(
      { tenantId: ctx.tenantId, region: ctx.region },
      { family, filename: stored.filename, mimeType: stored.mimeType, title, byteSize: bytes.length },
    );
  } catch (err) {
    console.warn("[brandKit] font upload record failed:", err);
    return NextResponse.json(
      { error: "record_failed", message: "Couldn't save the font to your library — try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ font });
}
