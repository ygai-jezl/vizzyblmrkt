import { NextResponse } from "next/server";
import { getTenantById } from "@/lib/tenant";
import { imageStyleAdmin } from "@/lib/content/imageStyle/admin";
import { renderStyleImage, type TemplateId } from "@/lib/content/imageStyle/render/styleImage";
import { RENDER_SIZES, type RenderSize } from "@/lib/content/imageStyle/render/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEWABLE: TemplateId[] = ["product_noir", "headline_card", "title_card"];
const HEX6 = /^#[0-9a-f]{6}$/i;
const SAMPLE = "Your headline goes here, *exactly as written*";

/**
 * Brand › Image style preview: a template drawn with the brand's own logo, fonts, accent and
 * newest screenshot, around a sample headline. Admin-only. `accent` and `logo=0` preview an
 * unsaved choice. A PNG, never cached.
 */
export async function GET(req: Request) {
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const template = PREVIEWABLE.find((t) => t === url.searchParams.get("styleId"));
  if (!template) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const sizeParam = url.searchParams.get("size") ?? "share";
  const size: RenderSize = sizeParam in RENDER_SIZES ? (sizeParam as RenderSize) : "share";
  const accent = url.searchParams.get("accent") ?? "";

  const tenant = await getTenantById(g.ctx.tenantId);
  const previewed =
    tenant && HEX6.test(accent)
      ? { ...tenant, imageStyle: { ...(tenant.imageStyle ?? { defaultStyleId: null }), accentHex: accent } }
      : tenant;
  const drawn = await renderStyleImage({
    ctx: g.ctx,
    tenant: previewed,
    template,
    size,
    headline: SAMPLE,
    eyebrow: "Preview",
    showLogo: url.searchParams.get("logo") !== "0",
  });
  if (!drawn) return NextResponse.json({ error: "render_failed" }, { status: 502 });
  return new Response(new Uint8Array(drawn.png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  });
}
