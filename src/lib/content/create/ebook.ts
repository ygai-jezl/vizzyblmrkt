/**
 * Shared constants + flags for the Create eBook studio. Pure + client-safe (no server
 * imports) so the wizard/studio can import the flag + aspect options while the routes
 * import the server flag + the Gemini aspect map. Mirrors socialImage.ts.
 */
import type { EbookAspect } from "@/lib/types/contentPlan";

/** Operator-facing eBook image aspect ratios: a square and a tall "page" portrait. */
export const EBOOK_ASPECTS = ["1:1", "1:4"] as const;

/** Dropdown labels for the aspect picker. */
export const EBOOK_ASPECT_LABELS: Record<EbookAspect, string> = {
  "1:1": "Square (1:1)",
  "1:4": "Tall page (1:4)",
};

/**
 * Map an operator aspect to the value passed to `imageConfig.aspectRatio`. The FULL
 * gemini-3.1-flash-image model (Vertex/enterprise) natively supports the extreme 1:4
 * ratio — verified against the Gemini Enterprise Agent Platform model page:
 *   1:1, 3:2, 2:3, 3:4, 1:4, 4:1, 4:3, 4:5, 5:4, 1:8, 8:1, 9:16, 16:9, 21:9, 9:21.
 * So this is a native pass-through (no cropping). Kept as a map so the offered set can
 * be widened, or a ratio remapped, without touching call sites.
 */
export const EBOOK_ASPECT_TO_GEMINI: Record<EbookAspect, string> = {
  "1:1": "1:1",
  "1:4": "1:4",
};

/** CSS `aspect-ratio` value for framing a slot in the reading pane. */
export function ebookAspectRatioCss(aspect: EbookAspect): string {
  return aspect === "1:4" ? "1 / 4" : "1 / 1";
}

/**
 * The model's documented inline-upload ceiling for image editing (image-in→image-out).
 * Uploads larger than this must go via GCS; we clamp edit inputs to it.
 */
export const EBOOK_IMAGE_INLINE_MAX_BYTES = 7 * 1024 * 1024;

/** The model's documented per-prompt input-image ceiling for the edit path. */
export const EBOOK_IMAGE_EDIT_MAX_INPUTS = 14;

/**
 * Art-direction style presets for eBook images. Same `{id,label,hint,keywords}` shape as
 * SOCIAL_IMAGE_STYLES but tuned for book illustration (illustration-leaning default rather
 * than photographic). `keywords` lead the expanded image prompt.
 */
export interface EbookImageStyle {
  id: string;
  label: string;
  hint: string;
  keywords: string;
}

export const EBOOK_IMAGE_STYLES: EbookImageStyle[] = [
  {
    id: "editorial",
    label: "Editorial illustration",
    hint: "Clean modern editorial art",
    keywords:
      "modern editorial illustration, flat vector shapes, limited confident palette, clean linework, generous negative space",
  },
  {
    id: "photographic",
    label: "Photographic",
    hint: "Realistic photography",
    keywords: "photorealistic, natural soft lighting, shallow depth of field, candid, high detail",
  },
  {
    id: "minimal",
    label: "Minimal line",
    hint: "Simple single-weight line art",
    keywords: "minimal single-weight line drawing, monochrome, lots of white space, elegant and restrained",
  },
  {
    id: "diagram",
    label: "Diagrammatic",
    hint: "Explanatory diagram / schematic",
    keywords: "clean explanatory diagram, labelled schematic feel, geometric isometric forms, muted infographic palette",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    hint: "Soft painted texture",
    keywords: "soft watercolor wash, organic texture, gentle gradients, hand-painted warmth",
  },
];

/** Tuple of style ids for zod route validation (kept in lockstep with EBOOK_IMAGE_STYLES; a test asserts it). */
export const EBOOK_IMAGE_STYLE_IDS = ["editorial", "photographic", "minimal", "diagram", "watercolor"] as const;
export type EbookImageStyleId = (typeof EBOOK_IMAGE_STYLE_IDS)[number];
export const DEFAULT_EBOOK_IMAGE_STYLE: EbookImageStyleId = "editorial";

/** Resolve a style id → preset (falls back to the first preset for an unknown id). */
export function ebookImageStyle(id: string): EbookImageStyle {
  return EBOOK_IMAGE_STYLES.find((s) => s.id === id) ?? EBOOK_IMAGE_STYLES[0]!;
}

/** Server flag — every studio route 503s unless this is on. */
export function isEbookEnabled(): boolean {
  return process.env.CREATE_EBOOK_ENABLED === "true";
}

/** Client mirror — the Scope toggle + studio only render when this is on. */
export function isEbookUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EBOOK_ENABLED === "true";
}
