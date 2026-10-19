import { NextResponse } from "next/server";
import { getTenantById } from "@/lib/tenant";
import { imageStyleAdmin } from "@/lib/content/imageStyle/admin";
import { renderStyleImage, type TemplateId } from "@/lib/content/imageStyle/render/styleImage";
import { RENDER_SIZES, type RenderSize } from "@/lib/content/imageStyle/render/render";
import { PREVIEWABLE_STYLES } from "@/lib/content/imageStyle/preview";
import { isMoreStylesEnabled } from "@/lib/content/imageStyle/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sample numbers for a Data story preview, said to be samples on the image itself. */
const SAMPLE_CHART = {
  kind: "bar" as const,
  unit: "%",
  points: [
    { label: "ChatGPT", value: 42 },
    { label: "Gemini", value: 31 },
    { label: "Perplexity", value: 18 },
  ],
  source: "Sample numbers",
};
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
  const asked = url.searchParams.get("styleId");
  const template = (asked === "title_card" ? "title_card" : PREVIEWABLE_STYLES.find((t) => t === asked)) as TemplateId | undefined;
  if (!template) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // The v2 styles preview only while they can be picked.
  if (["data_story", "type_poster", "line_art"].includes(template) && !isMoreStylesEnabled()) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
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
    ...(template === "data_story" ? { chart: SAMPLE_CHART } : {}),
    ...(template === "type_poster" ? { figure: { value: "19", unit: "days" } } : {}),
    ...(template === "line_art" ? { seed: 7 } : {}),
  });
  if (!drawn) return NextResponse.json({ error: "render_failed" }, { status: 502 });
  return new Response(new Uint8Array(drawn.png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  });
}
