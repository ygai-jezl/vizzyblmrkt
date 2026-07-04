import { cpLength, cutAtWord, type Truncation } from "./text";

/**
 * Instagram preview logic: the caption truncates at ~125 characters before the
 * "… more" affordance. Pure; an approximation of the native cutoff. (Carousel
 * slide media arrives with the Phase-2 carousel builder.)
 */

export const INSTAGRAM_CAPTION_CHARS = 125;

export function truncateCaption(
  body: string,
  limit = INSTAGRAM_CAPTION_CHARS,
): Truncation {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (cpLength(text) <= limit) return { visible: text, truncated: false };
  return { visible: cutAtWord(text, limit), truncated: true };
}
