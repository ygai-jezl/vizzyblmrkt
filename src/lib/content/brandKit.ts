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

export const BRAND_KIT_ROUTE = "/admin/brand-kit";
export const BRAND_KIT_IMAGES_ROUTE = "/admin/brand-kit/images";
export const BRAND_KIT_VOICE_ROUTE = "/admin/brand-kit/voice";

/**
 * The DERIVED URL for an image asset's bytes, served through the authenticated
 * workspace-asset proxy (the proxy reconstructs the GCS key from the session tenantId +
 * this workspaceId + filename, and re-validates workspace ownership). Never stored.
 */
export function imageAssetProxyUrl(a: { workspaceId: string; filename: string }): string {
  return `/api/admin/workspace/${encodeURIComponent(a.workspaceId)}/asset/${encodeURIComponent(a.filename)}`;
}
