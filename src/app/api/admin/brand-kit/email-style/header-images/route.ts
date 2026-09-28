import { NextResponse } from "next/server";
import { sniffImageMime } from "@/lib/workspace/assetStore";
import { storeBrandAsset } from "@/lib/tenant/brandAssetStore";
import { countBrandAssetsUpTo, recordBrandAsset } from "@/lib/admin/brandAssets";
import { EMAIL_HEADER_IMAGE_LIMITS } from "@/lib/types/tenant";
import { readImageSize, stripImageMetadata } from "@/lib/email/imageSize";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";
import { isEmailHeaderOptionsEnabled } from "@/lib/email/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PNG_OR_JPEG = new Set(["image/png", "image/jpeg"]);
const BAD_TYPE = "Upload a PNG or JPG — Outlook can't show WebP or SVG";

/** The upload's name without its path or extension, as the picker shows it. */
function headerImageTitle(name: unknown): string {
  const base = (typeof name === "string" ? name : "").split(/[/\\]/).pop() ?? "";
  return base.replace(/\.[^.]*$/, "").trim().slice(0, 200) || "Header image";
}

/**
 * Upload an email header image (Brand › Email style, `file` in FormData). Admin-only, like
 * every change on that page, and only with EMAIL_HEADER_OPTIONS_ENABLED. PNG or JPEG only
 * (declared AND sniffed: Outlook can't show WebP), at most 1 MB and 1200 × 2400 (the page
 * downsizes first, so the size check mainly stops a direct call), and at most 20 per tenant.
 * The size is read from the file itself and recorded on the row. The bytes, without their
 * metadata (stripImageMetadata: EXIF, text chunks, XMP, thumbnails), go to the brand asset
 * store under `header`, served publicly by /api/brand-asset/header/…. Using one in emails is
 * a separate Save.
 */
export async function POST(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  const { ctx } = g;
  if (!isEmailHeaderOptionsEnabled()) {
    return NextResponse.json({ error: "header_options_disabled" }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > EMAIL_HEADER_IMAGE_LIMITS.bytes) {
    return NextResponse.json(
      { error: "too_large", message: "The image is over 1 MB — try a smaller or simpler image." },
      { status: 413 },
    );
  }
  if (!PNG_OR_JPEG.has(file.type)) {
    return NextResponse.json({ error: "bad_type", message: BAD_TYPE }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  // Trust the SNIFFED type, not the declared one (the store alone would take a WebP).
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || !PNG_OR_JPEG.has(sniffed)) {
    return NextResponse.json({ error: "bad_type", message: BAD_TYPE }, { status: 400 });
  }
  // Stored without its metadata (EXIF, text chunks, XMP): the banner is public to every recipient.
  const stripped = stripImageMetadata(bytes);
  const clean = stripped ? Buffer.from(stripped) : null;
  const size = clean ? readImageSize(clean) : null;
  if (!clean || !size) {
    return NextResponse.json(
      { error: "bad_type", message: "We couldn't read this image — save it again as a PNG or JPG" },
      { status: 400 },
    );
  }
  if (size.width > EMAIL_HEADER_IMAGE_LIMITS.width || size.height > EMAIL_HEADER_IMAGE_LIMITS.height) {
    return NextResponse.json(
      { error: "bad_size", message: "Header images can be at most 1200px wide and 2400px tall" },
      { status: 400 },
    );
  }

  // The cap from ONE index-free read; a transient read failure skips it rather than blocking.
  let existingCount: number | null = null;
  try {
    existingCount = await countBrandAssetsUpTo(ctx, "header", EMAIL_HEADER_IMAGE_LIMITS.count + 1);
  } catch {
    existingCount = null;
  }
  if (existingCount !== null && existingCount >= EMAIL_HEADER_IMAGE_LIMITS.count) {
    return NextResponse.json(
      {
        error: "limit_reached",
        message: `You can keep up to ${EMAIL_HEADER_IMAGE_LIMITS.count} header images. Delete one to add another.`,
      },
      { status: 409 },
    );
  }

  const stored = await storeBrandAsset(ctx.tenantId, "header", clean, sniffed);
  if (!stored.ok) {
    return NextResponse.json(
      { error: stored.reason, message: "Couldn't save the image — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }

  let asset;
  try {
    asset = await recordBrandAsset(
      { tenantId: ctx.tenantId, region: ctx.region },
      {
        category: "header",
        filename: stored.filename,
        mimeType: stored.mimeType,
        title: headerImageTitle(file.name),
        byteSize: clean.length,
        width: size.width,
        height: size.height,
      },
    );
  } catch (err) {
    console.warn("[brandKit] header image record failed:", err);
    return NextResponse.json(
      { error: "record_failed", message: "Couldn't add the image to your header images — try again." },
      { status: 502 },
    );
  }

  const { id, title, filename, mimeType, byteSize, width, height, createdAt } = asset;
  return NextResponse.json({ image: { id, title, filename, mimeType, byteSize, width, height, createdAt } });
}
