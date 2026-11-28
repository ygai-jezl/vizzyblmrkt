import { NextResponse } from "next/server";
import { handBack, withStampToken } from "@/lib/loops/handBack";
import { learnedFor } from "@/lib/loops/read";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandColorsEnabled } from "@/lib/content/brandKit";
import { getTenantById } from "@/lib/tenant";
import { extractPaletteFromDomain } from "@/lib/content/create/paletteFromWebsite";
import { aiUsage } from "@/lib/plans/meter";

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

  const candidates = await extractPaletteFromDomain(domain, { usage: aiUsage(ctx, "brand_kit", { tenant }) });
  if (!candidates) return NextResponse.json({ error: "extraction_failed" }, { status: 502 });

  // Handed to the browser to save later: counted made once and its stamp signed for the save (learning loops step 5, decision 20).
  const stampToken = await handBack(ctx, "brand_kit", (await learnedFor(ctx, "brand_kit")).stamp);
  return NextResponse.json(withStampToken({ candidates, label: domain, source: "website" }, stampToken));
}
