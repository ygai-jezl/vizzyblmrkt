import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandColorsEnabled, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { getLogo, getPrimaryLogo, listLogos } from "@/lib/admin/brandLogos";
import { readBrandLogo } from "@/lib/tenant/brandLogo";
import {
  extractPaletteFromImageBytes,
  IMAGE_PALETTE_MIME,
  IMAGE_PALETTE_MAX_BYTES,
} from "@/lib/content/create/paletteFromImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({ logoId: z.string().max(64).optional() });

/**
 * Extract brand colours from an uploaded LOGO (the primary logo, or `logoId` if given, else the
 * newest) as review-tray candidates. Gated by BOTH the colours flag and the logos flag, so it
 * only appears where the Logos feature is live. Reuses the private logo store + vision helper;
 * every hex is pixel-estimated. Never persists.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandColorsEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  if (!isBrandKitLogosEnabled())
    return NextResponse.json({ error: "logos_not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // getLogo/getPrimaryLogo/listLogos are tenant-scoped (re-verify the stored tenantId).
  let logo = parsed.data.logoId
    ? await getLogo(ctx, parsed.data.logoId)
    : await getPrimaryLogo(ctx);
  if (!logo) logo = (await listLogos(ctx))[0] ?? null;
  if (!logo) return NextResponse.json({ error: "no_logo" }, { status: 404 });

  const asset = await readBrandLogo(ctx.tenantId, logo.filename);
  if (!asset) return NextResponse.json({ error: "logo_not_found" }, { status: 404 });
  if (!IMAGE_PALETTE_MIME.has(asset.contentType) || asset.bytes.length > IMAGE_PALETTE_MAX_BYTES) {
    return NextResponse.json({ error: "unsupported_logo" }, { status: 415 });
  }

  const candidates = await extractPaletteFromImageBytes(
    asset.bytes.toString("base64"),
    asset.contentType,
  );
  if (!candidates) return NextResponse.json({ error: "extraction_failed" }, { status: 502 });

  return NextResponse.json({ candidates, label: logo.title || "Logo", source: "logo" });
}
