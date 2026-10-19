/**
 * Switches for the brand image style (Brand › Image style, the style picker on every
 * image, the template renderer, learning per style) and the blog hero. Pure + client-safe.
 * Off = every image is made exactly as before (resolve.test.ts pins this).
 */
import { isBlogCitableEnabled, isBlogCitableUiEnabled } from "@/lib/content/blog/flags";

/** Server: the brand's image style, per-image overrides, templates, screenshots, learning per style. */
export function isBrandImageStyleEnabled(): boolean {
  return process.env.BRAND_IMAGE_STYLE_ENABLED === "true";
}

/** Client mirror: the Brand › Image style tile and page, and the style pickers. Read at build. */
export function isBrandImageStyleUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_IMAGE_STYLE_ENABLED === "true";
}

/** Server: every blog article gets a hero image (needs the image style and the CITABLE blog). */
export function isBlogHeroEnabled(): boolean {
  return process.env.BLOG_HERO_ENABLED === "true" && isBrandImageStyleEnabled() && isBlogCitableEnabled();
}

/** Client mirror: the hero card, its checklist item and the export additions. */
export function isBlogHeroUiEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_BLOG_HERO_ENABLED === "true" && isBrandImageStyleUiEnabled() && isBlogCitableUiEnabled()
  );
}

/**
 * Server: read the brand's website for its fonts and fetch Google fonts for images. Off =
 * images use uploaded fonts, then the bundled ones (no outbound font requests), which suits
 * a self-hosted install without internet access.
 */
export function isSiteFontsEnabled(): boolean {
  return process.env.BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED === "true" && isBrandImageStyleEnabled();
}

/** Client mirror: the "Found on your site" panel on Brand › Fonts. */
export function isSiteFontsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED === "true" && isBrandImageStyleUiEnabled();
}

/** Server: the v2 drawn styles (Data story, Type poster, Split card, Line art). Off = "Coming". */
export function isMoreStylesEnabled(): boolean {
  return process.env.BRAND_IMAGE_STYLE_MORE_ENABLED === "true" && isBrandImageStyleEnabled();
}

/** Client mirror: the four styles pickable in Brand › Image style and the pickers. */
export function isMoreStylesUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_IMAGE_STYLE_MORE_ENABLED === "true" && isBrandImageStyleUiEnabled();
}

/** Server: image formats (portrait card, partner lockup, report cover) and the eBook report cover. */
export function isImageFormatsEnabled(): boolean {
  return process.env.IMAGE_FORMATS_ENABLED === "true" && isBrandImageStyleEnabled();
}

/** Client mirror: the Format menus on social posts, the hero card and the eBook cover. */
export function isImageFormatsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IMAGE_FORMATS_ENABLED === "true" && isBrandImageStyleUiEnabled();
}
