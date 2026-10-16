import type { PaletteColor } from "@/lib/types/tenant";

const MAX_PALETTE = 24;
const MAX_FONTS = 12;

const hexKey = (hex: string) => hex.trim().toLowerCase().replace(/^#/, "");

/**
 * A guidelines PDF ADDS to the Colour palette, never replaces it: the colours
 * already there stay first, with their names (Email style looks for "Primary" and
 * "Accent"), and the PDF's colours that aren't there yet follow, up to the limit.
 */
export function mergeExtractedPalette(
  existing: PaletteColor[] | null | undefined,
  extracted: PaletteColor[] | null | undefined,
): PaletteColor[] | null {
  const kept = existing ?? [];
  const seen = new Set(kept.map((c) => hexKey(c.hex)));
  const added = (extracted ?? []).filter((c) => {
    const k = hexKey(c.hex);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out = [...kept, ...added].slice(0, MAX_PALETTE);
  return out.length ? out : (existing ?? extracted ?? null);
}

/** The same for the fonts list: the ones already set stay, the PDF's new ones follow. */
export function mergeExtractedFonts(existing: string[] | null | undefined, extracted: string[] | null | undefined): string[] | null {
  const kept = existing ?? [];
  const seen = new Set(kept.map((f) => f.trim().toLowerCase()));
  const added = (extracted ?? []).filter((f) => {
    const k = f.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out = [...kept, ...added].slice(0, MAX_FONTS);
  return out.length ? out : (existing ?? extracted ?? null);
}
