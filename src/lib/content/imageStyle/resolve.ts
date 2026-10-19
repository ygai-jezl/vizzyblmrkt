/**
 * Which style one image is made in. Pure + client-safe (the pickers show the same answer
 * the server uses).
 *
 * Order: the image's own pick (made when it is generated) → the brand's style for this
 * channel → the brand's default. With the switch off, or before the brand has picked, every
 * surface keeps exactly what it does today: social posts the Corporate Cinematic preset,
 * eBook images the Editorial preset, emails today's prompt. A blog hero (new) defaults to
 * the Headline card.
 */
import type { ImageStyleChannel, ImageStyleId, StoredImageStyle } from "@/lib/types/imageStyle";
import { imageStyleById, type ImageStyleDefinition, type ImageStyleRequirement } from "./catalogue";
import { DEFAULT_SOCIAL_IMAGE_STYLE, SOCIAL_IMAGE_STYLE_IDS } from "@/lib/content/create/socialImage";
import { DEFAULT_EBOOK_IMAGE_STYLE, EBOOK_IMAGE_STYLE_IDS } from "@/lib/content/create/ebook";

/** Where an image is being made. */
export type ImageSurface = "social" | "blogHero" | "ebook" | "email" | "launchEmail";

/** Where the answer came from (shown in the pickers: "Brand default", "This post only"). */
export type ImageStyleSource = "override" | "channel" | "default" | "legacy" | "fallback";

export type ResolvedImageStyle =
  | {
      engine: "legacy";
      /** The old preset to use, or null for a surface that had none (emails: today's prompt). */
      presetId: string | null;
      source: ImageStyleSource;
    }
  | {
      engine: "model";
      id: ImageStyleId;
      label: string;
      keywords: string;
      source: ImageStyleSource;
    }
  | {
      engine: "template";
      id: ImageStyleId;
      label: string;
      requires: ImageStyleRequirement[];
      /** The model style to use when the template can't be made (no screenshot, render failed). */
      modelTwin: ImageStyleId | null;
      source: ImageStyleSource;
    };

export interface ResolveImageStyleInput {
  /** isBrandImageStyleEnabled() on the server, isBrandImageStyleUiEnabled() in the browser. */
  enabled: boolean;
  surface: ImageSurface;
  /** For social: the post's channel ("linkedin" | "x" | "instagram"). */
  channel?: string | null;
  brand?: StoredImageStyle | null;
  /** The image's own pick: a style id, an old preset id, "brand" or null (= the brand's). */
  override?: string | null;
}

/** Surfaces a template can be rendered for (a template needs a fixed, known frame). */
const TEMPLATE_SURFACES: ReadonlySet<ImageSurface> = new Set(["social", "blogHero"]);

function legacyPresets(surface: ImageSurface): readonly string[] {
  if (surface === "social") return SOCIAL_IMAGE_STYLE_IDS;
  if (surface === "ebook") return EBOOK_IMAGE_STYLE_IDS;
  return [];
}

function legacyDefault(surface: ImageSurface): string | null {
  if (surface === "social") return DEFAULT_SOCIAL_IMAGE_STYLE;
  if (surface === "ebook") return DEFAULT_EBOOK_IMAGE_STYLE;
  return null;
}

/** The brand's per-channel key for this surface. */
export function channelKeyFor(surface: ImageSurface, channel?: string | null): ImageStyleChannel | null {
  switch (surface) {
    case "blogHero":
      return "blogHero";
    case "ebook":
      return "ebook";
    case "email":
      return "newsletter";
    case "launchEmail":
      return "launchEmail";
    case "social":
      return channel === "linkedin" || channel === "x" || channel === "instagram" ? channel : null;
  }
}

/** A chosen style as it can actually be made here: built, and a template only where one fits. */
export function usableStyle(id: string, surface: ImageSurface): ImageStyleDefinition | null {
  let def = imageStyleById(id);
  for (let hops = 0; def && hops < 4; hops++) {
    if (!def.built) {
      def = imageStyleById(def.builtFallback);
      continue;
    }
    if (def.engine === "template" && !TEMPLATE_SURFACES.has(surface)) {
      def = imageStyleById(def.modelTwin);
      continue;
    }
    return def;
  }
  return null;
}

function fromDefinition(def: ImageStyleDefinition, source: ImageStyleSource): ResolvedImageStyle {
  return def.engine === "template"
    ? { engine: "template", id: def.id, label: def.label, requires: def.requires, modelTwin: def.modelTwin, source }
    : { engine: "model", id: def.id, label: def.label, keywords: def.keywords, source };
}

export function resolveImageStyle(input: ResolveImageStyleInput): ResolvedImageStyle {
  const { surface } = input;
  const override = input.override && input.override !== "brand" ? input.override : null;
  const presets = legacyPresets(surface);

  if (!input.enabled) {
    const presetId = override && presets.includes(override) ? override : legacyDefault(surface);
    return { engine: "legacy", presetId, source: override && presetId === override ? "override" : "legacy" };
  }

  // 1. The image's own pick.
  if (override) {
    const def = usableStyle(override, surface);
    if (def) return fromDefinition(def, "override");
    if (presets.includes(override)) return { engine: "legacy", presetId: override, source: "override" };
  }

  // 2. The brand's style for this channel, 3. the brand's default.
  const brand = input.brand ?? null;
  const key = channelKeyFor(surface, input.channel);
  const channelPick = key ? brand?.channels?.[key] : undefined;
  if (channelPick) {
    const def = usableStyle(channelPick, surface);
    if (def) return fromDefinition(def, "channel");
  }
  if (brand?.defaultStyleId) {
    const def = usableStyle(brand.defaultStyleId, surface);
    if (def) return fromDefinition(def, "default");
  }

  // 4. Nothing picked: today's behaviour, and the Headline card for a blog hero.
  if (surface === "blogHero") {
    const def = usableStyle("headline_card", surface);
    if (def) return fromDefinition(def, "fallback");
  }
  return { engine: "legacy", presetId: legacyDefault(surface), source: "legacy" };
}
