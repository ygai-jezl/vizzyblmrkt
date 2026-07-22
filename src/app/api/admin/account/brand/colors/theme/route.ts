import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandColorsEnabled } from "@/lib/content/brandKit";
import { getTenantById } from "@/lib/tenant";
import { clampColors } from "@/lib/content/create/colorPalette";
import { extractPaletteFromDomain } from "@/lib/content/create/paletteFromWebsite";
import { generateColorTheme } from "@/lib/content/create/colorTheme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  seed: z.array(z.unknown()).max(48).optional(),
  mode: z.enum(["expand", "fresh"]).optional(),
});

/**
 * Generate an AI colour THEME as review-tray candidates (never persisted). Seed resolution is
 * WEBSITE-FIRST: an explicit seed from the client wins; otherwise we extract from the primary
 * domain; otherwise fall back to the saved palette; otherwise a "fresh" theme grounded in the
 * brand voice/summary/domain. All inbound seed hex is re-validated (clampColors drops junk).
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandColorsEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const tenant = await getTenantById(ctx.tenantId);

  let seed = clampColors(parsed.data.seed ?? []);
  let mode = parsed.data.mode;
  if (!seed.length && tenant?.rootDomain?.trim()) {
    const web = await extractPaletteFromDomain(tenant.rootDomain.trim()).catch(() => null);
    if (web?.length) seed = web;
  }
  if (!seed.length && tenant?.brandKit?.palette?.length) {
    seed = clampColors(tenant.brandKit.palette);
  }
  // With no seed at all, design a fresh palette rather than "expand" nothing.
  if (!seed.length) mode = "fresh";

  const candidates = await generateColorTheme({
    seed,
    mode,
    brandSummary: tenant?.brandKit?.summary ?? null,
    brandVoice: tenant?.brandVoice?.summary ?? null,
    domain: tenant?.rootDomain ?? null,
    tenantName: tenant?.tenantName ?? null,
  });
  if (!candidates) return NextResponse.json({ error: "generation_failed" }, { status: 502 });

  return NextResponse.json({ candidates, label: "AI theme", source: "ai" });
}
