import { NextResponse } from "next/server";
import { getTenantById } from "@/lib/tenant";
import { setTenantSiteFonts } from "@/lib/tenant/control";
import { imageStyleAdmin } from "@/lib/content/imageStyle/admin";
import { isSiteFontsEnabled } from "@/lib/content/imageStyle/flags";
import { detectSiteFonts } from "@/lib/content/create/fontsFromWebsite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Brand › Fonts "Check my site": read the brand's primary domain for its fonts (HTML and CSS
 * text only) and save the result as the fonts images use when none was uploaded. Admin-only;
 * needs BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED (outbound fetches). 400 with no primary domain,
 * 502 when the site can't be read (nothing is saved then).
 */
export async function POST(req: Request) {
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  if (!isSiteFontsEnabled()) return NextResponse.json({ error: "site_fonts_disabled" }, { status: 503 });

  const tenant = await getTenantById(g.ctx.tenantId);
  const domain = tenant?.rootDomain?.trim();
  if (!domain) return NextResponse.json({ error: "no_primary_domain" }, { status: 400 });

  const fonts = await detectSiteFonts(domain);
  if (!fonts) {
    return NextResponse.json(
      { error: "site_unreadable", message: `We couldn't read ${domain}. Try again, or upload your fonts.` },
      { status: 502 },
    );
  }
  await setTenantSiteFonts(g.ctx.tenantId, fonts);
  return NextResponse.json({ siteFonts: fonts });
}
