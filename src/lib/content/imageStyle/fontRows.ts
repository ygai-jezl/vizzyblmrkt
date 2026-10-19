import type { BrandFont } from "@/lib/types/brandFont";

/**
 * Pure facts about an uploaded font row, safe for the client: which stored file the image
 * renderer can use, and a label for its weight. See render/fonts.ts for how rows get them.
 */

/** The stored file the renderer can read: the TTF copy of a WOFF2, else the upload itself. */
export function renderableFilename(font: BrandFont): string | null {
  if (font.mimeType === "font/woff2") return font.derivedFilename ?? null;
  // Read, and nothing came back: the file isn't a font the renderer can use.
  if (font.inspectedAt && font.weight === undefined) return null;
  return font.filename;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

/** "Bold", "Regular italic", "650"; null when the font hasn't been read. */
export function fontWeightLabel(font: Pick<BrandFont, "weight" | "italic">): string | null {
  if (font.weight === undefined) return null;
  const name = WEIGHT_NAMES[font.weight] ?? String(font.weight);
  return font.italic ? `${name} italic` : name;
}
