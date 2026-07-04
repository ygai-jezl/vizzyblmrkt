import { deconstructToThread } from "../threadDeconstructor";

/**
 * Plan a carousel: split a body into one-idea-per-slide text blocks (reusing the
 * header-aware thread deconstructor), capped at a practical carousel length. Pure.
 * `truncated` surfaces when content was dropped to fit the cap (no silent cut).
 */

export const MAX_CAROUSEL_SLIDES = 10; // LinkedIn/Instagram practical carousel cap
/** Per-slide text budget — keep a slide legible when rendered as an image. */
export const SLIDE_TEXT_MAX = 280;

export interface CarouselSlide {
  index: number; // 1-based
  text: string;
}

export interface SlidePlan {
  slides: CarouselSlide[];
  truncated: boolean;
}

export function planSlides(body: string, maxSlides = MAX_CAROUSEL_SLIDES): SlidePlan {
  const cap = Math.max(1, Math.min(Math.floor(maxSlides) || MAX_CAROUSEL_SLIDES, MAX_CAROUSEL_SLIDES));
  const parts = deconstructToThread(body, SLIDE_TEXT_MAX);
  const slides = parts.slice(0, cap).map((text, i) => ({ index: i + 1, text }));
  return { slides, truncated: parts.length > cap };
}

/** The image-generation prompt for one slide (Gemini renders the text on the slide). */
export function slideImagePrompt(
  slide: CarouselSlide,
  total: number,
  opts: { brandHint?: string } = {},
): string {
  const brand = opts.brandHint?.trim();
  // Neutralise the fenced delimiter so body text can't break out + prompt-inject.
  const safeText = slide.text.replace(/"""+/g, '"');
  return [
    "Design a clean, modern social-media carousel slide, square 1:1 aspect ratio.",
    `This is slide ${slide.index} of ${total}.`,
    "Render the following text legibly and prominently on the slide:",
    `"""${safeText}"""`,
    brand ? `Brand style guidance: ${brand}.` : "",
    "Use high contrast, generous whitespace, one clear idea per slide, and a subtle background. No watermarks or logos.",
  ]
    .filter(Boolean)
    .join("\n");
}
