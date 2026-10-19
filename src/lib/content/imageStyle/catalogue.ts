/**
 * The image style catalogue: the 13 looks a brand can choose as its default (Brand › Image
 * style) or for one image when it is made. Pure + client-safe (the pickers import it).
 *
 * Two engines:
 * - `model`: the image model paints the art from `keywords` (no words in the art).
 * - `template`: code lays out the brand's fonts, logo, real numbers and screenshots
 *   (src/lib/content/imageStyle/render), so words are always exact.
 *
 * v1 builds 9 styles. An unbuilt style keeps a saved choice and resolves to `builtFallback`.
 * A template style on a surface that can't take one (eBook, email) resolves to `modelTwin`.
 */
import type { ImageStyleId } from "@/lib/types/imageStyle";

export type ImageStyleEngine = "model" | "template";

/** What a style needs from the brand to look its best. Reported, never enforced. */
export type ImageStyleRequirement = "screenshots";

export interface ImageStyleDefinition {
  id: ImageStyleId;
  /** Two-digit number from the study, for the pickers ("01"). */
  number: string;
  label: string;
  /** One short line for the pickers. */
  hint: string;
  engine: ImageStyleEngine;
  /** Built in this release. */
  built: boolean;
  /** Model styles: the art direction that leads the image prompt. */
  keywords: string;
  requires: ImageStyleRequirement[];
  /** Template styles: the model style used where a template can't go (eBook, email). */
  modelTwin: ImageStyleId | null;
  /** Unbuilt styles: the built style used until this one ships. */
  builtFallback: ImageStyleId | null;
}

export const IMAGE_STYLES: readonly ImageStyleDefinition[] = [
  {
    id: "product_noir",
    number: "01",
    label: "Product noir",
    hint: "Near-black, your real product screens, silver type, one accent.",
    engine: "template",
    built: true,
    keywords: "",
    requires: ["screenshots"],
    modelTwin: "product_still_life",
    builtFallback: null,
  },
  {
    id: "headline_card",
    number: "02",
    label: "Headline card",
    hint: "Brand gradient, a bold headline with one phrase highlighted, a proof point.",
    engine: "template",
    built: true,
    keywords: "",
    requires: [],
    modelTwin: "illustration",
    builtFallback: null,
  },
  {
    id: "data_story",
    number: "03",
    label: "Data story",
    hint: "One chart or one big number, annotated, with its source.",
    engine: "template",
    built: false,
    keywords: "",
    requires: [],
    modelTwin: "illustration",
    builtFallback: "headline_card",
  },
  {
    id: "type_poster",
    number: "04",
    label: "Type poster",
    hint: "One colour block and giant type.",
    engine: "template",
    built: false,
    keywords: "",
    requires: [],
    modelTwin: "illustration",
    builtFallback: "headline_card",
  },
  {
    id: "illustration",
    number: "05",
    label: "Illustration",
    hint: "Flat shapes in brand colours, one visual metaphor.",
    engine: "model",
    built: true,
    keywords:
      "modern editorial illustration, flat vector shapes in the brand palette, one clear visual metaphor for the idea, limited confident palette, generous negative space, subtle paper grain",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "editorial_photo",
    number: "06",
    label: "Editorial photo",
    hint: "Moody photography with a strong colour grade and grain.",
    engine: "model",
    built: true,
    keywords:
      "editorial photography with a strong colour grade or duotone in the brand colours, moody directional light, film grain, shallow depth of field, cinematic framing",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "soft_3d",
    number: "07",
    label: "Soft 3D",
    hint: "Glossy objects, soft studio light, pastel ground.",
    engine: "model",
    built: true,
    keywords:
      "soft 3D render, glossy and matte clay objects, soft studio lighting, pastel gradient backdrop drawn from the brand colours, one symbolic hero object, gentle long shadows",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "paper_collage",
    number: "08",
    label: "Paper collage",
    hint: "Torn paper, halftone, riso colour, tape. Looks handmade.",
    engine: "model",
    built: true,
    keywords:
      "handmade paper collage, torn paper edges, halftone photo scraps, risograph colour with slight misregistration, masking tape, marker scribbles, tactile paper texture",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "natural_photo",
    number: "09",
    label: "Natural photo",
    hint: "Bright, true colour. Real people, places and work in daylight.",
    engine: "model",
    built: true,
    keywords:
      "natural documentary photography, bright daylight, true-to-life colour, real people and real places, candid unposed moment, shallow depth of field, no heavy filters",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "product_still_life",
    number: "10",
    label: "Product still life",
    hint: "Your product on a bold colour, with props and hard light.",
    engine: "model",
    built: true,
    keywords:
      "studio product still life, the product on a seamless bold backdrop in the brand colour, a simple plinth and a few props, hard directional light with crisp shadows",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "brand_character",
    number: "11",
    label: "Brand character",
    hint: "One mascot in flat, bright colour, acting out the post.",
    engine: "model",
    built: true,
    keywords:
      "flat bright character illustration, one friendly brand mascot acting out the idea, rounded shapes, solid colour background, no outlines, cheerful and simple",
    requires: [],
    modelTwin: null,
    builtFallback: null,
  },
  {
    id: "split_card",
    number: "12",
    label: "Split card",
    hint: "A photo beside a brand-colour panel with the headline.",
    engine: "template",
    built: false,
    keywords: "",
    requires: [],
    modelTwin: "natural_photo",
    builtFallback: "natural_photo",
  },
  {
    id: "line_art",
    number: "13",
    label: "Line art",
    hint: "Fine lines in one or two colours on a plain ground.",
    engine: "template",
    built: false,
    keywords: "",
    requires: [],
    modelTwin: "illustration",
    builtFallback: "illustration",
  },
];

const BY_ID = new Map<string, ImageStyleDefinition>(IMAGE_STYLES.map((s) => [s.id, s]));

/** The style with this id, or null. */
export function imageStyleById(id: string | null | undefined): ImageStyleDefinition | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Built styles only, in catalogue order (the pickers' choosable list). */
export function builtImageStyles(): ImageStyleDefinition[] {
  return IMAGE_STYLES.filter((s) => s.built);
}

/**
 * The old per-image presets (Create's social and eBook style menus) mapped to the new
 * styles. Used to sort old images into learning buckets and to pre-select a default; an
 * explicit old pick is still honoured as that old look. `null` = no matching style.
 */
export const LEGACY_TO_STYLE: Readonly<Record<string, ImageStyleId | null>> = {
  // Social presets (src/lib/content/create/socialImage.ts)
  minimalist: "product_still_life",
  vibrant: "soft_3d",
  earthy: "natural_photo",
  retro: "natural_photo",
  cyberpunk: null,
  luxury: "editorial_photo",
  brutalist: "paper_collage",
  handcrafted: "illustration",
  cinematic: "editorial_photo",
  popart: "illustration",
  // eBook presets (src/lib/content/create/ebook.ts)
  editorial: "illustration",
  photographic: "natural_photo",
  minimal: "illustration",
  diagram: "illustration",
  watercolor: "illustration",
};

/** The learning bucket an image's stored `style` belongs to (new ids map to themselves). */
export function canonicalStyleId(style: string | null | undefined): ImageStyleId | null {
  if (!style) return null;
  const direct = imageStyleById(style);
  if (direct) return direct.id;
  return style in LEGACY_TO_STYLE ? (LEGACY_TO_STYLE[style] ?? null) : null;
}
