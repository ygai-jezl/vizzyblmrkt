/**
 * Flags + route constants for the Brand Kit asset library (Content OS sidebar item).
 * Pure + client-safe (no server imports) so both the sidebar (client) and the routes/
 * pages (server) can import from here. Mirrors src/lib/content/create/socialImage.ts.
 *
 * NOTE: distinct from the tenant BRAND GUIDELINES (`tenant.brandKit`, Account → Brand).
 * This module governs the AI-image ASSET LIBRARY, not the guidelines kit.
 */

/** Server flag — the Brand Kit routes 503 and the pages notFound() unless this is on. */
export function isBrandKitEnabled(): boolean {
  return process.env.BRAND_KIT_ENABLED === "true";
}

/** Client mirror — the sidebar only shows the Brand Kit item when this is on. */
export function isBrandKitUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_KIT_ENABLED === "true";
}

/**
 * Server flag — the Brand Voice route/page 503/notFound() unless this is on. Governs the
 * authored tenant-global brand voice (Summary/Do/Don't) and its grounding. Independent of
 * BRAND_KIT_ENABLED (the gallery), though the voice page hangs off the Brand Kit tile.
 */
export function isBrandVoiceEnabled(): boolean {
  return process.env.BRAND_VOICE_ENABLED === "true";
}

/** Client mirror — the Brand Kit "Brand voice" tile only links out when this is on. */
export function isBrandVoiceUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_VOICE_ENABLED === "true";
}

/**
 * Server flag — the Brand Kit → Logos route/page 503/notFound() unless this is on.
 * Governs the tenant's uploaded corporate-logo library + the primary-logo email wiring.
 * Independent of BRAND_KIT_ENABLED so it can roll out on its own (needs the brand_logos
 * composite index live in prod first).
 */
export function isBrandKitLogosEnabled(): boolean {
  return process.env.BRAND_KIT_LOGOS_ENABLED === "true";
}

/** Client mirror — the Brand Kit "Logos" tile only links out when this is on. */
export function isBrandKitLogosUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_KIT_LOGOS_ENABLED === "true";
}

/**
 * Server flag — the Colours-card extraction routes (PDF / website / AI theme / logo palette)
 * 503 unless this is on. Governs the "build a palette from a source, review, keep" flow in
 * Account → Brand. No new infra — reuses Gemini + the existing brand PDF / logo storage.
 */
export function isBrandColorsEnabled(): boolean {
  return process.env.BRAND_COLORS_ENABLED === "true";
}

/** Client mirror — the Colours card only shows the extract/generate actions + review tray + palette groups when this is on. */
export function isBrandColorsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_COLORS_ENABLED === "true";
}

/**
 * Server flag — the Content Steering surface (the transparent view of the learned
 * post-performance directive + version timeline + point-in-time revert). Its read/revert
 * routes 503 unless this is on. Governs visibility only; the LEARNING is gated separately by
 * POST_PATTERNS_LEARN_ENABLED and injection by POST_PATTERNS_INJECT_ENABLED.
 */
export function isContentSteeringEnabled(): boolean {
  return process.env.CONTENT_STEERING_ENABLED === "true";
}

/** Client mirror — the Content Steering card only links out when this is on. */
export function isContentSteeringUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONTENT_STEERING_ENABLED === "true";
}

/**
 * Server flag — the Brand Kit → Fonts routes/page 503/notFound() unless this is on. Governs the
 * tenant-global typography (text styles + guidelines, `tenant.brandTypography`) AND the uploaded
 * custom font-file library (`brand_fonts`). Independent of BRAND_KIT_ENABLED so it can roll out on
 * its own (needs the brand_fonts composite index live in prod first).
 */
export function isBrandFontsEnabled(): boolean {
  return process.env.BRAND_FONTS_ENABLED === "true";
}

/** Client mirror — the Brand Kit "Fonts" tile only links out when this is on. */
export function isBrandFontsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_FONTS_ENABLED === "true";
}

/**
 * Server flag — the Brand Kit → Icons / Graphics routes/pages 503/notFound() unless this is on.
 * Governs the tenant-global uploaded ICON + GRAPHIC libraries (`brand_assets`). Independent of
 * BRAND_KIT_ENABLED so it can roll out on its own (needs the brand_assets composite index live in
 * prod first). ONE flag drives both categories (they share a collection + gallery).
 */
export function isBrandAssetsEnabled(): boolean {
  return process.env.BRAND_ASSETS_ENABLED === "true";
}

/** Client mirror — the Brand Kit "Icons" + "Graphics" tiles only link out when this is on. */
export function isBrandAssetsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_ASSETS_ENABLED === "true";
}

/**
 * Server-only flag — attach the tenant's uploaded ICONS + GRAPHICS as visual reference images to
 * image generation (deep reference integration). Mirrors BRAND_STYLE_REFS_ENABLED: it gates ONLY
 * whether the bytes are fed to the model, not whether the library exists. Off by default so the
 * libraries can ship inert.
 */
export function isBrandAssetRefsEnabled(): boolean {
  return process.env.BRAND_ASSET_REFS_ENABLED === "true";
}

export const BRAND_KIT_ROUTE = "/admin/brand-kit";
export const BRAND_KIT_IMAGES_ROUTE = "/admin/brand-kit/images";
export const BRAND_KIT_VOICE_ROUTE = "/admin/brand-kit/voice";
export const BRAND_KIT_LOGOS_ROUTE = "/admin/brand-kit/logos";
export const BRAND_KIT_STEERING_ROUTE = "/admin/brand-kit/steering";
export const BRAND_KIT_FONTS_ROUTE = "/admin/brand-kit/fonts";
export const BRAND_KIT_COLOURS_ROUTE = "/admin/brand-kit/colours";
export const BRAND_KIT_ICONS_ROUTE = "/admin/brand-kit/icons";
export const BRAND_KIT_GRAPHICS_ROUTE = "/admin/brand-kit/graphics";

/**
 * The DERIVED URL for an image asset's bytes, served through the authenticated
 * workspace-asset proxy (the proxy reconstructs the GCS key from the session tenantId +
 * this workspaceId + filename, and re-validates workspace ownership). Never stored.
 */
export function imageAssetProxyUrl(a: { workspaceId: string; filename: string }): string {
  return `/api/admin/workspace/${encodeURIComponent(a.workspaceId)}/asset/${encodeURIComponent(a.filename)}`;
}

/**
 * RELATIVE public URL for a brand logo's bytes (served by the public /api/brand-logo
 * proxy, uuid-guarded). Works in the admin gallery (same-origin). Never stored.
 */
export function brandLogoPublicUrl(tenantId: string, filename: string): string {
  return `/api/brand-logo/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}

/**
 * ABSOLUTE public URL for a brand logo — required for recipient-facing EMAILS (inboxes aren't
 * same-origin). The caller passes a resolved `origin` (e.g. `platformOrigin() ||
 * originFromHeaders(headers)`, the same pattern email hero images use) so this is always a
 * real absolute URL, never a relative path that would break in an inbox.
 */
export function brandLogoAbsoluteUrl(origin: string, tenantId: string, filename: string): string {
  return `${origin.replace(/\/+$/, "")}${brandLogoPublicUrl(tenantId, filename)}`;
}

/**
 * RELATIVE public URL for an uploaded brand FONT file (served by the public /api/brand-font proxy,
 * uuid-guarded). Used in the Fonts manager's @font-face rules for in-app preview. Never stored.
 */
export function brandFontPublicUrl(tenantId: string, filename: string): string {
  return `/api/brand-font/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}

/**
 * RELATIVE public URL for an uploaded brand ASSET (icon/graphic) — served by the public
 * /api/brand-asset proxy (uuid-guarded). The category is part of the path so the proxy can
 * reconstruct the `brand/{tenantId}/{category}s/{filename}` key. Never stored.
 */
export function brandAssetPublicUrl(
  tenantId: string,
  category: "icon" | "graphic",
  filename: string,
): string {
  return `/api/brand-asset/${encodeURIComponent(category)}/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}
