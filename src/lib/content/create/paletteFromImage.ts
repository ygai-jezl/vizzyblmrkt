import { generateTextWithImage, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { clampColors } from "./colorPalette";
import type { PaletteColor } from "@/lib/types/tenant";

/**
 * Vision-extract the dominant brand colours from an image's bytes (a logo, favicon, or
 * og:image). Every hex is pixel-ESTIMATED, so `clampColors` forces `estimated:true`. Shared
 * by the website favicon/og-image boost and the logo colour source. Fail-soft: null on any
 * model/parse failure. Callers own the size cap + content-type allow-list before inlining.
 */

/** Gemini vision handles these reliably; ICO/SVG are skipped by callers. */
export const IMAGE_PALETTE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Cap inlined image bytes (base64 inflates ~4/3; keep the request comfortably small). */
export const IMAGE_PALETTE_MAX_BYTES = 4 * 1024 * 1024;

export async function extractPaletteFromImageBytes(
  base64: string,
  mimeType: string,
): Promise<PaletteColor[] | null> {
  const raw = await generateTextWithImage(
    renderPrompt("brand.extract_image_palette", {}),
    base64,
    mimeType,
  );
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object") return null;
  const colors = clampColors((json as Record<string, unknown>).palette, { forceEstimated: true });
  return colors.length ? colors : null;
}
