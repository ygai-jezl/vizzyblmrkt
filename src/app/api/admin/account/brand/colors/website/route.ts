import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandColorsEnabled } from "@/lib/content/brandKit";
import { getTenantById } from "@/lib/tenant";
import { extractPaletteFromDomain } from "@/lib/content/create/paletteFromWebsite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Extract a brand's colour palette from its PRIMARY DOMAIN (`tenant.rootDomain`) and return it
 * as review-tray candidates (never persisted). 400 when no primary domain is set (client links
 * to the Domains tab); 502 when nothing usable was found / the model is unavailable.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandColorsEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  const domain = tenant?.rootDomain?.trim();
  if (!domain) return NextResponse.json({ error: "no_primary_domain" }, { status: 400 });

  const candidates = await extractPaletteFromDomain(domain);
  if (!candidates) return NextResponse.json({ error: "extraction_failed" }, { status: 502 });

  return NextResponse.json({ candidates, label: domain, source: "website" });
}
