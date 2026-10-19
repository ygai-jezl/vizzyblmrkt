/**
 * Learning per style (BRAND_IMAGE_STYLE_ENABLED): which learned directive an image's prompt
 * gets. Pure.
 *
 * - `undefined`: use the brand's one learned look, exactly as before (assembleBrandContext's
 *   default). That's the answer until the brand has learned anything per style, so turning
 *   the switch on never makes images worse on day one.
 * - a string: what was learned from thumbs on images in this style.
 * - `null`: this brand learns per style, and nothing has been learned for this one yet.
 */
import type { StoredImageStyle } from "@/lib/types/imageStyle";
import { imageStyleById } from "./catalogue";

export function learnedDirectiveFor(
  imageStyle: StoredImageStyle | null | undefined,
  styleBucket: string | null,
): string | null | undefined {
  if (!styleBucket) return undefined;
  const learned = imageStyle?.learned;
  if (!learned || Object.keys(learned).length === 0) return undefined;
  return learned[styleBucket]?.directive ?? null;
}

/** Only image-model styles learn from thumbs: a template's look is fixed by its layout. */
export function learnsFromThumbs(styleBucket: string | null): boolean {
  return imageStyleById(styleBucket)?.engine === "model";
}
