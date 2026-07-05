/**
 * Greyscale social "favicon" chips as self-contained SVG data-URIs (no network,
 * no origin needed) so they render in the sandboxed preview iframe. Pure + client-
 * safe (encodeURIComponent works in both Node and the browser; Buffer/btoa do not).
 *
 * NOTE: data-URI/SVG images are a MOCK — reliable in the editor preview, but blocked
 * by some email clients (Gmail). A hosted-PNG icon set via /api/email-asset is the
 * production follow-up.
 */
const GLYPH: Record<string, string> = {
  x: "𝕏",
  linkedin: "in",
  facebook: "f",
  instagram: "◉",
  youtube: "▶",
  tiktok: "♪",
  website: "@",
};

export function socialIconDataUri(platform: string): string {
  const glyph = GLYPH[platform] ?? "@";
  const size = glyph.length > 1 ? 10 : 13;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="5" fill="#8a8a8a"/>` +
    `<text x="12" y="17" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="700" fill="#ffffff" text-anchor="middle">${glyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
