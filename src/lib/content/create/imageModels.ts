/**
 * Operator-facing IMAGE MODEL choices, shared by every image-creation surface (social post
 * nodes, the eBook studio, email-layout blocks, and Brand Kit Customise). The operator picks
 * a stable SLUG ("lite" | "full"); the SERVER resolves the slug to the actual, env-overridable
 * model id via `resolveImageModel` in modelConfig — so we never ship a hard-coded model string
 * to the client and the deployed model stays env-configurable (model-hardcoding policy).
 *
 * Pure + client-safe (no server imports) so both the UI dropdown and the route zod schema can
 * import from here. Today the two options map to the two Nano Banana 2 variants:
 *   lite → GEMINI_BLOCK_IMAGE_MODEL (gemini-3.1-flash-lite-image) — faster / cheaper
 *   full → GEMINI_EBOOK_IMAGE_MODEL (gemini-3.1-flash-image)      — higher quality, edit-capable
 */

export const IMAGE_MODEL_CHOICES = [
  {
    slug: "lite",
    label: "Nano Banana 2 Lite",
    hint: "Faster and lower cost — great for quick drafts and simple visuals.",
  },
  {
    slug: "full",
    label: "Nano Banana 2",
    hint: "Higher quality and edit-capable — best for hero images and refinements.",
  },
] as const;

export type ImageModelSlug = (typeof IMAGE_MODEL_CHOICES)[number]["slug"];

/** The slugs as a tuple, for zod enum validation on the routes. */
export const IMAGE_MODEL_SLUGS = IMAGE_MODEL_CHOICES.map((c) => c.slug) as [
  ImageModelSlug,
  ...ImageModelSlug[],
];

/** Narrow an unknown value to a valid model slug. */
export function isImageModelSlug(x: unknown): x is ImageModelSlug {
  return typeof x === "string" && (IMAGE_MODEL_SLUGS as readonly string[]).includes(x);
}

/**
 * Per-surface DEFAULT model slug — pre-selects the dropdown to each surface's CURRENT model so
 * behaviour is unchanged until the operator switches. Social + email default to the lite model;
 * the eBook studio + Brand Kit Customise (image-in → image-out edits) default to the full model.
 */
export const DEFAULT_IMAGE_MODEL_SLUG = {
  social: "lite",
  email: "lite",
  ebook: "full",
  customise: "full",
} as const satisfies Record<string, ImageModelSlug>;

/**
 * The value a UI should SEND as a per-generation model override: the selected slug ONLY when the
 * operator changed it from this surface's default; otherwise `undefined`. Callers put the result
 * straight into the JSON body — `JSON.stringify` drops an `undefined` value, so the field is
 * omitted and the server keeps its EXISTING/automatic behaviour (e.g. the social path's lite→full
 * upgrade when brand-style references are attached). Sending the default slug unconditionally would
 * turn "no override" into an explicit choice and defeat that auto-upgrade — see the social path in
 * creative.ts / generateSocialPostImage.
 */
export function imageModelOverride(
  selected: ImageModelSlug,
  surface: keyof typeof DEFAULT_IMAGE_MODEL_SLUG,
): ImageModelSlug | undefined {
  return selected === DEFAULT_IMAGE_MODEL_SLUG[surface] ? undefined : selected;
}
