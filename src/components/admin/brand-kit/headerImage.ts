import { EMAIL_HEADER_IMAGE_LIMITS } from "@/lib/types/tenant";
import type { BrandAsset } from "@/lib/types/brandAsset";

/**
 * Email header images (a banner in place of the logo and name) for the Brand › Email style
 * page: which files it takes, how the browser shrinks and encodes one before upload, its name,
 * and what the page warns about. Pure: no DOM, so HeaderImagePicker runs the canvas and the
 * tests run these on made-up sizes.
 */

/** A header image the page can offer: the brand_assets row, with the size read at upload. */
export type EmailHeaderImageChoice = Pick<
  BrandAsset,
  "id" | "title" | "filename" | "mimeType" | "byteSize" | "createdAt"
> & { width: number; height: number };

/** The only types a banner can be: Outlook can't show WebP or SVG. */
export type BannerType = "image/png" | "image/jpeg";

export const BANNER_TYPE_MESSAGE = "Upload a PNG or JPG — Outlook can't show WebP or SVG";

/** Narrower than this, a banner may look blurry on large screens (the band is up to 608 wide). */
export const BANNER_MIN_WIDTH = 600;

/** Taller than this when shown 600px wide, readers scroll before the message. */
export const BANNER_MAX_SHOWN_HEIGHT = 400;

/** Past this, a banner may load slowly on phones. */
export const HEAVY_BANNER_BYTES = 300 * 1024;

/** The ladder's second width, for an image still over the byte cap at the full 1200. */
export const BANNER_SMALLER_WIDTH = 1000;

/** A banner's name is at most this long (the upload keeps 200 characters of its title). */
const MAX_NAME = 200;

/** The extensions a banner's name loses before it gains its own. */
const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|heic|heif|avif|svg|bmp|tiff?)$/i;

export function isBannerType(mime: string): mime is BannerType {
  return mime === "image/png" || mime === "image/jpeg";
}

/**
 * The size a banner is drawn at: its own, scaled down (never up), keeping its shape, to fit
 * inside `maxWidth` × 2400. It never refuses: a very tall image is shrunk to 2400 tall (and
 * the page warns it's tall for a header). Null only for an image with no size.
 */
export function bannerSize(
  width: number,
  height: number,
  maxWidth: number = EMAIL_HEADER_IMAGE_LIMITS.width,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const maxHeight = EMAIL_HEADER_IMAGE_LIMITS.height;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.min(maxWidth, Math.max(1, Math.round(width * scale))),
    height: Math.min(maxHeight, Math.max(1, Math.round(height * scale))),
  };
}

/** One try at a file under the byte cap: the file as picked, or a redraw at ≤ `maxWidth` in `mime`. */
export type BannerStep = "original" | { maxWidth: number; mime: BannerType; quality?: number };

const STILL_OVER = "This image is still over 1 MB after shrinking — try a smaller or simpler image";
const PNG_OVER = "This PNG is over 1 MB even at 1000px wide — try a JPG, or a PNG with fewer colours";

/**
 * The fixed ladder the page climbs until a result is at most 1 MB, and what it says when none
 * is. A JPEG is always redrawn (the browser applies its EXIF rotation when drawing and the
 * metadata goes, so a phone photo can't arrive sideways), at falling quality, then 1000 wide.
 * A PNG that already fits 1200 × 2400 is tried as it is first (the upload route strips its
 * metadata), else redrawn as a PNG; an opaque one then turns into a JPEG, while one with
 * transparency stays a PNG (a JPEG would lose it) and only gets narrower.
 */
export function bannerAttempts(input: {
  type: BannerType;
  /** Every pixel is opaque (PNG only: a JPEG always is). */
  opaque: boolean;
  width: number;
  height: number;
}): { steps: BannerStep[]; refusal: string } {
  const full = EMAIL_HEADER_IMAGE_LIMITS.width;
  const jpeg = (maxWidth: number, quality: number): BannerStep => ({ maxWidth, mime: "image/jpeg", quality });
  if (input.type === "image/jpeg") {
    return {
      steps: [jpeg(full, 0.9), jpeg(full, 0.8), jpeg(full, 0.7), jpeg(BANNER_SMALLER_WIDTH, 0.8)],
      refusal: STILL_OVER,
    };
  }
  const size = bannerSize(input.width, input.height);
  const fits = size !== null && size.width === input.width && size.height === input.height;
  const first: BannerStep = fits ? "original" : { maxWidth: full, mime: "image/png" };
  if (input.opaque) {
    return {
      steps: [first, jpeg(full, 0.85), jpeg(full, 0.75), jpeg(BANNER_SMALLER_WIDTH, 0.8)],
      refusal: STILL_OVER,
    };
  }
  return { steps: [first, { maxWidth: BANNER_SMALLER_WIDTH, mime: "image/png" }], refusal: PNG_OVER };
}

/**
 * Climb the ladder: encode each step in turn and take the first result at most `maxBytes`.
 * "unreadable" when a step can't be encoded (a canvas that failed), "too_big" when none fits.
 * Nothing over the cap is ever returned.
 */
export async function climbBannerLadder<T extends { size: number }>(
  steps: readonly BannerStep[],
  encode: (step: BannerStep) => Promise<T | null>,
  maxBytes: number = EMAIL_HEADER_IMAGE_LIMITS.bytes,
): Promise<{ step: BannerStep; result: T } | "unreadable" | "too_big"> {
  for (const step of steps) {
    const result = await encode(step);
    if (!result) return "unreadable";
    if (result.size <= maxBytes) return { step, result };
  }
  return "too_big";
}

/** Every pixel is opaque (RGBA bytes, as getImageData gives them). */
export function allOpaque(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 255) return false;
  return true;
}

/**
 * The uploaded file's name, which becomes the banner's title once the server drops the
 * extension: the picked name without its path or image extension ("Header image" if that
 * leaves nothing), with `.png` or `.jpg` for what's sent, all within 200 characters.
 */
export function bannerFileName(name: string, type: BannerType): string {
  const ext = type === "image/png" ? ".png" : ".jpg";
  const base = name.split(/[/\\]/).pop() ?? "";
  const stem = base.trim().replace(IMAGE_EXT, "").trim() || "Header image";
  // Never cut a character in half.
  const clipped = stem.slice(0, MAX_NAME - ext.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return `${clipped}${ext}`;
}

/**
 * What the page warns about for a banner (never blocks): under 600px wide, taller than 400px
 * when shown 600px wide, and over 300 KB. An unknown byte size skips the last.
 */
export function bannerWarnings(image: { width: number; height: number; byteSize?: number | null }): string[] {
  const warnings: string[] = [];
  if (image.width < BANNER_MIN_WIDTH) {
    warnings.push("This image is under 600px wide, so it may look blurry on large screens — 1200px wide is best");
  }
  const shown = Math.round((image.height * BANNER_MIN_WIDTH) / image.width);
  if (shown > BANNER_MAX_SHOWN_HEIGHT) {
    warnings.push(
      `This image is tall for a header (${shown} px at 600px wide), so readers scroll before your message — under 400 is best`,
    );
  }
  if (image.byteSize != null && image.byteSize > HEAVY_BANNER_BYTES) {
    warnings.push("This image is over 300 KB, so it may load slowly on phones — a JPG at 1200px wide is usually smaller");
  }
  return warnings;
}
