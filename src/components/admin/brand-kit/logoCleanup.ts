import { normalizeHex } from "@/lib/content/create/colorPalette";

/**
 * Logo clean-up for the Brand › Email style page: turn a logo with a white box baked in into
 * a transparent PNG ("Remove white background") or an all-white mark ("Make logo white") for a
 * coloured email header. Pure: it works on RGBA bytes as getImageData gives them, with no DOM,
 * so LogoCleanupPanel runs it on a canvas and the tests on made-up images. It suits a one-colour
 * logo on plain white; for anything else the page's before/after preview is the guard.
 */

/** The working canvas's long side: a bigger logo is scaled down to this first. */
export const CLEANUP_WORK_SIZE = 1200;

/** The saved PNG fits this box: 3× the header's 200×48, so it stays sharp on sharp screens. */
export const CLEANUP_OUTPUT = { width: 600, height: 144 } as const;

/** How far from white (255 − the lowest channel) a pixel can be and still count as background. */
const NEAR_WHITE = 24;

/** The soft edge: ink within this many pixels of the background is faded, not cut. */
const EDGE = 2;

/** Trimming keeps pixels at least this opaque, plus this much room around them. */
const TRIM_ALPHA = 8;
const TRIM_PAD = 2;

/** Make logo white: the ink is the 5th-percentile darkness of the pixels darker than 0.9 luma. */
const INK_PERCENTILE = 0.05;
const LIGHT_LUMA = 0.9;

/** A pixel less dark than this (1 − luma) is JPEG noise, so it's cleared, whatever the ink. */
const NOISE_FLOOR = 0.03;

/** A corner is white when its 2×2 block is all at least this opaque and this light (every channel). */
const CORNER_ALPHA = 250;
const CORNER_WHITE = 235;

/** A logo's name is at most this long (the upload route keeps 200 characters). */
const MAX_NAME = 200;

export type CleanupMode = "remove" | "white";

/** The cleaned pixels, or why there's nothing to clean. */
export type Cleaned = { changed: true; rgba: Uint8ClampedArray } | { changed: false; message: string };

/**
 * Remove a logo's white background. The background is what a flood fill reaches from the
 * image's edges through near-white pixels; it turns transparent. Ink within 2px of it fades
 * with how far it is from white, measured against the darkest ink nearby, and its colour is
 * taken back to that ink (so no white halo shows on a dark header). White the fill can't reach
 * — the white of an eye, the inside of an "o" — stays white. `rgba` is opaque (drawn on white).
 */
export function removeWhiteBackground(rgba: ArrayLike<number>, width: number, height: number): Cleaned {
  const n = width * height;
  const dist = new Uint8Array(n);
  for (let i = 0; i < n; i++) dist[i] = 255 - Math.min(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);

  // 4-connected flood fill from every near-white edge pixel.
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const reach = (i: number) => {
    if (!bg[i] && dist[i]! <= NEAR_WHITE) {
      bg[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    reach(x);
    reach((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    reach(y * width);
    reach(y * width + width - 1);
  }
  if (!tail) return { changed: false, message: "No white background found around the edges" };
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    if (x > 0) reach(i - 1);
    if (x < width - 1) reach(i + 1);
    if (i >= width) reach(i - width);
    if (i < n - width) reach(i + width);
  }

  const out = new Uint8ClampedArray(n * 4); // the background stays transparent
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (bg[i]) continue;
      const p = i * 4;
      out[p] = rgba[p]!;
      out[p + 1] = rgba[p + 1]!;
      out[p + 2] = rgba[p + 2]!;
      out[p + 3] = 255;
      // Near-white the fill didn't reach is enclosed: it stays as it is.
      if (dist[i]! <= NEAR_WHITE) continue;
      let nearBackground = false;
      let ink = 0;
      for (let yy = Math.max(0, y - EDGE); yy <= Math.min(height - 1, y + EDGE); yy++) {
        for (let xx = Math.max(0, x - EDGE); xx <= Math.min(width - 1, x + EDGE); xx++) {
          const j = yy * width + xx;
          if (bg[j]) nearBackground = true;
          else if (dist[j]! > ink) ink = dist[j]!;
        }
      }
      if (!nearBackground) continue;
      // The edge pixel is ink blended with white: undo the blend.
      const alpha = Math.min(1, dist[i]! / ink);
      out[p + 3] = Math.round(alpha * 255);
      for (let c = 0; c < 3; c++) out[p + c] = 255 - (255 - rgba[p + c]!) / alpha;
    }
  }
  return { changed: true, rgba: out };
}

/**
 * Make a logo white: every pixel turns white, as opaque as it is dark, measured against the
 * logo's ink (so a one-colour mark of any colour turns solid white). White details, the
 * insides of letters included, turn see-through, which is the look on a coloured header.
 * Removes a white background too. `rgba` is opaque (drawn on white).
 */
export function makeWhite(rgba: ArrayLike<number>, width: number, height: number): Cleaned {
  const n = width * height;
  const luma = new Float32Array(n);
  // The ink, from a histogram of the darker pixels (each bin keeps its lowest luma).
  const counts = new Uint32Array(256);
  const lowest = new Float32Array(256).fill(1);
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const l = (0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!) / 255;
    luma[i] = l;
    if (l >= LIGHT_LUMA) continue;
    const bin = Math.floor(l * 255);
    counts[bin]!++;
    if (l < lowest[bin]!) lowest[bin] = l;
    dark++;
  }
  if (!dark) return { changed: false, message: "This logo is too light to turn white" };
  const rank = Math.max(1, Math.ceil(dark * INK_PERCENTILE));
  let bin = 0;
  for (let seen = counts[0]!; seen < rank; seen += counts[++bin]!);
  const ink = lowest[bin]!;

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // The floor applies before scaling to the ink: a light ink would lift the noise into a haze.
    const dark = 1 - luma[i]!;
    const alpha = dark < NOISE_FLOOR ? 0 : Math.min(1, dark / (1 - ink));
    const p = i * 4;
    out[p] = 255;
    out[p + 1] = 255;
    out[p + 2] = 255;
    out[p + 3] = Math.round(alpha * 255);
  }
  return { changed: true, rgba: out };
}

/** The box around what's left (pixels at least a little opaque), with 2px of room; null when nothing is. */
export function trimBox(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]! < TRIM_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - TRIM_PAD);
  const y = Math.max(0, minY - TRIM_PAD);
  return {
    x,
    y,
    width: Math.min(width, maxX + 1 + TRIM_PAD) - x,
    height: Math.min(height, maxY + 1 + TRIM_PAD) - y,
  };
}

/** A size scaled down (never up) to fit `box`, keeping its shape. */
export function fitWithin(
  width: number,
  height: number,
  box: { width: number; height: number } = CLEANUP_OUTPUT,
): { width: number; height: number } {
  const scale = Math.min(1, box.width / width, box.height / height);
  return {
    width: Math.min(box.width, Math.max(1, Math.round(width * scale))),
    height: Math.min(box.height, Math.max(1, Math.round(height * scale))),
  };
}

/**
 * The logo has an opaque white background: at least 3 of its 4 corners are white. Run on the
 * page's small sample of the logo (drawn on a transparent canvas, so a transparent corner isn't white).
 */
export function hasWhiteBackground(rgba: ArrayLike<number>, width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const white = (x0: number, y0: number) => {
    for (let y = y0; y < Math.min(height, y0 + 2); y++) {
      for (let x = x0; x < Math.min(width, x0 + 2); x++) {
        const p = (y * width + x) * 4;
        if (rgba[p + 3]! < CORNER_ALPHA || Math.min(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!) < CORNER_WHITE) return false;
      }
    }
    return true;
  };
  const right = Math.max(0, width - 2);
  const bottom = Math.max(0, height - 2);
  return [white(0, 0), white(right, 0), white(0, bottom), white(right, bottom)].filter(Boolean).length >= 3;
}

/** A white logo background shows as a box on this header: some of it (a stop) isn't near-white itself. */
export function showsAsWhiteBox(stops: readonly string[]): boolean {
  return stops.some((s) => {
    const hex = normalizeHex(s);
    return !hex || Math.min(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))) < CORNER_WHITE;
  });
}

/**
 * The cleaned-up logo's name in Brand › Logos: "<name> (no background).png" or "<name>
 * (white).png", from the original's name without its extension. Slashes become dashes (the
 * upload keeps only a path's last part), and the whole name fits 200 characters.
 */
export function cleanupFileName(title: string, mode: CleanupMode): string {
  const suffix = mode === "white" ? " (white).png" : " (no background).png";
  const stem =
    title
      .trim()
      .replace(/\.(png|jpe?g|webp)$/i, "")
      .replace(/[/\\]/g, "-")
      .trim() || "Logo";
  // Never cut a character in half.
  const clipped = stem.slice(0, MAX_NAME - suffix.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return `${clipped}${suffix}`;
}
