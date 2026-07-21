import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { getTenantById } from "@/lib/tenant";
import { generateBrandVoiceFromDomain } from "@/lib/content/create/brandVoiceGen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI-draft a brand voice grounded in the tenant's PRIMARY DOMAIN (`tenant.rootDomain`).
 * Returns the draft for the operator to review + save (does NOT persist). 400 when no primary
 * domain is set (the client links to the Domains tab); 502 when the model is unavailable.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandVoiceEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getTenantById(ctx.tenantId);
  const domain = tenant?.rootDomain?.trim();
  if (!domain) {
    return NextResponse.json({ error: "no_primary_domain" }, { status: 400 });
  }

  const voice = await generateBrandVoiceFromDomain(domain);
  if (!voice) {
    return NextResponse.json({ error: "generation_failed" }, { status: 502 });
  }
  // Stamp provenance so a saved AI-drafted voice records which domain (and when) it came from.
  return NextResponse.json({
    brandVoice: { ...voice, sourceDomain: domain, generatedAt: new Date().toISOString() },
  });
}
