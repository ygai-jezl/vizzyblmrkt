import type { ReactElement } from "react";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { getPrimaryLogo } from "@/lib/admin/brandLogos";
import { readBrandLogo } from "@/lib/tenant/brandLogo";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import { readBrandAsset } from "@/lib/tenant/brandAssetStore";
import { readImageSize } from "@/lib/email/imageSize";
import { renderPng, RENDER_SIZES, type RenderSize } from "./render";
import { bundledFontPlan, fontsForRender, type FontPlan } from "./renderFonts";
import type { TemplateImage, TemplateInput } from "./templates/shared";
import { productNoir } from "./templates/productNoir";
import { headlineCard } from "./templates/headlineCard";
import { titleCard } from "./templates/titleCard";
import { artOverlay } from "./templates/artOverlay";

/**
 * Draw a brand image from a template: gathers the brand's accent, name, primary logo, newest
 * screenshot (Product noir) and fonts, then renders. Returns null when the render fails, so the
 * caller can fall back (the title card, which uses only bundled fonts, is the last resort).
 */

export type TemplateId = "product_noir" | "headline_card" | "title_card" | "art_overlay";

const TEMPLATES: Record<TemplateId, (i: TemplateInput) => ReactElement> = {
  product_noir: productNoir,
  headline_card: headlineCard,
  title_card: titleCard,
  art_overlay: artOverlay,
};

const DEFAULT_ACCENT = "#5B4FE6";
const HEX6 = /^#[0-9a-f]{6}$/i;

/** The accent images use: the one set on Brand › Image style, else the palette's first colour. */
export function accentFor(tenant: Tenant | null): string {
  const set = tenant?.imageStyle?.accentHex;
  if (set && HEX6.test(set)) return set;
  const first = tenant?.brandKit?.palette?.find((c) => HEX6.test(c.hex))?.hex;
  return first ?? DEFAULT_ACCENT;
}

function dataUri(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** PNG or JPEG bytes as a template image; anything else (WebP, GIF) is left out. */
export function asTemplateImage(bytes: Buffer, declaredMime?: string): TemplateImage | null {
  const size = readImageSize(bytes);
  if (!size) return null;
  const mime = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : declaredMime;
  if (mime !== "image/png" && mime !== "image/jpeg") return null;
  return { src: dataUri(bytes, mime), width: size.width, height: size.height };
}

async function logoFor(ctx: TenantContext): Promise<TemplateImage | null> {
  try {
    const logo = await getPrimaryLogo(ctx);
    if (!logo) return null;
    const file = await readBrandLogo(ctx.tenantId, logo.filename);
    return file ? asTemplateImage(file.bytes, file.contentType) : null;
  } catch {
    return null;
  }
}

/** The newest screenshot in Brand › Screenshots. */
async function screenshotFor(ctx: TenantContext): Promise<TemplateImage | null> {
  try {
    const [newest] = await listBrandAssets(ctx, "screenshot");
    if (!newest) return null;
    const file = await readBrandAsset(ctx.tenantId, "screenshot", newest.filename);
    return file ? asTemplateImage(file.bytes, file.contentType) : null;
  } catch {
    return null;
  }
}

export interface StyleImageRequest {
  ctx: TenantContext;
  tenant: Tenant | null;
  template: TemplateId;
  size: RenderSize;
  headline: string;
  eyebrow?: string | null;
  subline?: string | null;
  footer?: string | null;
  /** Image-model art to lay type over (art_overlay). */
  art?: Buffer | null;
  showHeadline?: boolean;
  showLogo?: boolean;
}

export interface StyleImageResult {
  png: Buffer;
  width: number;
  height: number;
  note?: "no_screenshot" | "bundled_font";
}

export async function renderStyleImage(req: StyleImageRequest): Promise<StyleImageResult | null> {
  const { width, height } = RENDER_SIZES[req.size];
  const showLogo = req.showLogo ?? req.tenant?.imageStyle?.logoOnSocial ?? true;
  const [logo, screenshot] = await Promise.all([
    showLogo ? logoFor(req.ctx) : Promise.resolve(null),
    req.template === "product_noir" ? screenshotFor(req.ctx) : Promise.resolve(null),
  ]);
  const brandName = (req.tenant?.tenantName ?? "").trim().slice(0, 40) || "Your brand";
  const text = [req.headline.replace(/\*/g, ""), req.eyebrow, req.subline, req.footer, logo ? "" : brandName]
    .filter(Boolean)
    .join(" ");

  let plan: FontPlan;
  try {
    plan = req.template === "title_card" ? await bundledFontPlan() : await fontsForRender({ ctx: req.ctx, tenant: req.tenant, text });
  } catch {
    plan = await bundledFontPlan();
  }

  const input: TemplateInput = {
    width,
    height,
    headline: req.headline,
    eyebrow: req.eyebrow ?? null,
    subline: req.subline ?? null,
    footer: req.footer ?? null,
    accent: accentFor(req.tenant),
    brandName,
    logo,
    screenshot,
    art: req.art ? asTemplateImage(req.art) : null,
    showHeadline: req.showHeadline,
    showLogo,
    fonts: { heading: plan.heading, body: plan.body },
  };
  const png = await renderPng(TEMPLATES[req.template](input), { width, height, fonts: plan.fonts });
  if (!png) return null;
  const note =
    req.template === "product_noir" && !screenshot ? "no_screenshot" : plan.bundledOnly && req.template !== "title_card" ? "bundled_font" : undefined;
  return { png, width, height, ...(note ? { note } : {}) };
}
