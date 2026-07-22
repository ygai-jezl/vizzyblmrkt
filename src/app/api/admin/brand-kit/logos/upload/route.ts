import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isAllowedScreenshotType } from "@/lib/workspace/assetStore";
import { storeBrandLogo, MAX_LOGO_BYTES } from "@/lib/tenant/brandLogo";
import { recordLogo, countLogosUpTo, MAX_LOGOS_PER_TENANT } from "@/lib/admin/brandLogos";
import { isBrandKitLogosEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload a corporate logo (PNG / JPG / WebP) into the tenant's brand-global Logos library.
 * Bytes go to the private bucket under `brand/{tenantId}/logos/...` and a `brand_logos`
 * registry row is recorded. The FIRST logo a tenant uploads becomes the primary (the one
 * defaulted into email headers). FLAG-GATED (BRAND_KIT_LOGOS_ENABLED). Same-origin only;
 * type is trusted from the magic-byte sniff inside storeBrandLogo, not the client.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandKitLogosEnabled()) {
    return NextResponse.json({ error: "brand_kit_logos_disabled" }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (file.size > MAX_LOGO_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: "Logo is too large (max 8 MB)." },
      { status: 413 },
    );
  }
  if (!isAllowedScreenshotType(file.type)) {
    return NextResponse.json(
      { error: "bad_type", message: "Upload a PNG, JPG or WebP image." },
      { status: 400 },
    );
  }

  // Enforce the per-tenant cap + decide the first-logo primary from ONE index-free read
  // (no orderBy → works even while the brand_logos composite index is still building).
  // A transient read failure (null) skips the cap and defaults to non-primary rather than
  // assuming "first" — getPrimaryLogo derives the newest as primary in that case anyway.
  let existingCount: number | null = null;
  try {
    existingCount = await countLogosUpTo(ctx, MAX_LOGOS_PER_TENANT + 1);
  } catch {
    existingCount = null;
  }
  if (existingCount !== null && existingCount >= MAX_LOGOS_PER_TENANT) {
    return NextResponse.json(
      {
        error: "limit_reached",
        message: `You can store up to ${MAX_LOGOS_PER_TENANT} logos. Delete one to add another.`,
      },
      { status: 409 },
    );
  }
  const isPrimary = existingCount === 0;

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await storeBrandLogo(ctx.tenantId, bytes, file.type);
  if (!stored.ok) {
    if (stored.reason === "too_large") {
      return NextResponse.json(
        { error: stored.reason, message: "Logo is too large (max 8 MB)." },
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
      { error: stored.reason, message: "Couldn't save the logo — try again." },
      { status: stored.reason === "no_asset_bucket" ? 503 : 502 },
    );
  }

  // Display name = the uploaded filename (path-stripped, capped). Falls back to "Logo".
  const rawName = typeof file.name === "string" ? file.name : "";
  const title = (rawName.split(/[/\\]/).pop() || "Logo").slice(0, 200);

  let logo;
  try {
    logo = await recordLogo(
      { tenantId: ctx.tenantId, region: ctx.region },
      {
        filename: stored.filename,
        mimeType: stored.mimeType,
        title,
        byteSize: bytes.length,
        isPrimary,
      },
    );
  } catch (err) {
    console.warn("[brandKit] logo upload record failed:", err);
    return NextResponse.json(
      { error: "record_failed", message: "Couldn't save the logo to your library — try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ logo });
}
