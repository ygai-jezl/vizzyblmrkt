import { z } from "zod";

/**
 * A brand's image style (Brand › Image style): the look every new image starts from, set
 * once per brand, with an optional style per channel. Any single image can still pick a
 * different style when it is made (its own `imageStyleId`). Lives on the tenant doc next to
 * the Email style. Every field reads leniently: a damaged value reads as none, never a throw.
 *
 * The 13 ids match the Design canvas study (Styles page). v1 builds 9 of them; the other 4
 * are listed so a saved choice survives, and resolve to their nearest built style
 * (src/lib/content/imageStyle/catalogue.ts).
 */
export const IMAGE_STYLE_IDS = [
  "product_noir",
  "headline_card",
  "data_story",
  "type_poster",
  "illustration",
  "editorial_photo",
  "soft_3d",
  "paper_collage",
  "natural_photo",
  "product_still_life",
  "brand_character",
  "split_card",
  "line_art",
] as const;
export const ImageStyleIdSchema = z.enum(IMAGE_STYLE_IDS);
export type ImageStyleId = z.infer<typeof ImageStyleIdSchema>;

/** Where a brand can set a style of its own, apart from the default. */
export const IMAGE_STYLE_CHANNELS = [
  "blogHero",
  "linkedin",
  "x",
  "instagram",
  "newsletter",
  "ebook",
  "launchEmail",
] as const;
export const ImageStyleChannelSchema = z.enum(IMAGE_STYLE_CHANNELS);
export type ImageStyleChannel = z.infer<typeof ImageStyleChannelSchema>;

const HexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Per-channel styles, read leniently (a damaged entry reads as unset). */
const StoredChannelsSchema = z.object({
  blogHero: ImageStyleIdSchema.optional().catch(undefined),
  linkedin: ImageStyleIdSchema.optional().catch(undefined),
  x: ImageStyleIdSchema.optional().catch(undefined),
  instagram: ImageStyleIdSchema.optional().catch(undefined),
  newsletter: ImageStyleIdSchema.optional().catch(undefined),
  ebook: ImageStyleIdSchema.optional().catch(undefined),
  launchEmail: ImageStyleIdSchema.optional().catch(undefined),
});

/** What the style engine has learned for one style from the brand's thumbs up and down. */
export const LearnedStyleSchema = z.object({
  directive: z.string().max(2000).nullable(),
  sampleCount: z.number().int().nonnegative(),
  updatedAt: z.string().max(40),
});
export type LearnedStyle = z.infer<typeof LearnedStyleSchema>;

/** One font found on the brand's website, and what images use for it. */
export const SiteFontSchema = z.object({
  /** The family images use (a Google family, a free match, or a bundled font). */
  family: z.string().min(1).max(80),
  /** The family named on the site; null when the site uses only system fonts. */
  detected: z.string().max(80).nullable(),
  source: z.enum(["google", "match", "bundled"]),
});
export type SiteFont = z.infer<typeof SiteFontSchema>;

export const SiteFontsSchema = z.object({
  heading: SiteFontSchema.nullable(),
  body: SiteFontSchema.nullable(),
  /** The site that was read (host only). */
  domain: z.string().max(253),
  detectedAt: z.string().max(40),
  /** True when the site names only system fonts (e.g. -apple-system, Segoe UI). */
  systemOnly: z.boolean().optional(),
});
export type SiteFonts = z.infer<typeof SiteFontsSchema>;

/** The stored style. `learned` keys are style ids (checked on write). */
export const StoredImageStyleSchema = z.object({
  defaultStyleId: ImageStyleIdSchema.nullable().catch(null),
  channels: StoredChannelsSchema.optional().catch(undefined),
  /** The accent images use; absent = the brand palette's first colour. */
  accentHex: HexSchema.optional().catch(undefined),
  /** Social images carry the logo in a corner (template styles and type laid over art). */
  logoOnSocial: z.boolean().optional().catch(undefined),
  /** Social images carry the post's headline (template styles and type laid over art). */
  headlineOnSocial: z.boolean().optional().catch(undefined),
  siteFonts: SiteFontsSchema.optional().catch(undefined),
  learned: z.record(z.string(), LearnedStyleSchema).optional().catch(undefined),
  updatedAt: z.string().max(40).optional().catch(undefined),
  /** Firebase UID of who saved it. Never shown or sent to Vizzy. */
  updatedBy: z.string().max(128).optional().catch(undefined),
});
export type StoredImageStyle = z.infer<typeof StoredImageStyleSchema>;

/** What the Brand › Image style page (and an applied suggestion) saves. Strict. */
export const ImageStyleInputSchema = z
  .object({
    defaultStyleId: ImageStyleIdSchema.nullable(),
    channels: z
      .object({
        blogHero: ImageStyleIdSchema.optional(),
        linkedin: ImageStyleIdSchema.optional(),
        x: ImageStyleIdSchema.optional(),
        instagram: ImageStyleIdSchema.optional(),
        newsletter: ImageStyleIdSchema.optional(),
        ebook: ImageStyleIdSchema.optional(),
        launchEmail: ImageStyleIdSchema.optional(),
      })
      .strict()
      .default({}),
    accentHex: HexSchema.nullable().default(null),
    logoOnSocial: z.boolean().default(true),
    headlineOnSocial: z.boolean().default(true),
  })
  .strict();
export type ImageStyleInput = z.infer<typeof ImageStyleInputSchema>;

export const IMAGE_STYLE_SUGGESTION_LIMITS = { reason: 500 } as const;

/**
 * A style Vizzy suggested, waiting for an admin to save it. Generation never reads it.
 * `suggestedAt` is the compare-and-clear key, so a Save or Dismiss never clears a newer one.
 */
export const ImageStyleSuggestionSchema = z.object({
  defaultStyleId: ImageStyleIdSchema,
  channels: ImageStyleInputSchema.shape.channels.optional(),
  /** Why, in a sentence (shown on the page). */
  reason: z.string().max(IMAGE_STYLE_SUGGESTION_LIMITS.reason),
  /** Firebase UID of who asked Vizzy, or "agent". Never shown or sent to Vizzy. */
  suggestedBy: z.string().min(1).max(128),
  suggestedAt: z.string().min(1).max(40),
});
export type ImageStyleSuggestion = z.infer<typeof ImageStyleSuggestionSchema>;
