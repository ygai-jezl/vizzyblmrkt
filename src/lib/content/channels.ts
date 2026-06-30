/**
 * Distribution CHANNELS + FORMATS + per-channel structural blueprints. A template
 * targets a channel (platform) in a format (native shape). Blueprints are the
 * structural guides injected into templatize/transform prompts. Pure + client-safe.
 */
export interface Channel {
  id: string;
  label: string;
  /** Structural guidance for content native to this channel. */
  blueprint: string;
}

export const CHANNELS: Channel[] = [
  {
    id: "blog",
    label: "Blog (SEO/GEO)",
    blueprint:
      "H1 action-oriented title → pain-point hook + thesis → H2 subtopic hubs → H3 supporting detail (numbered list for sequential steps, bullets for alternatives, a table for comparisons) → FAQ/structured-data block → clear next step. Strict H2>H3 hierarchy.",
  },
  {
    id: "newsletter",
    label: "Email Newsletter",
    blueprint:
      "Editorial, curated sections: an eyebrow title + bold headline, a scannable body, and one clear CTA. Stack distinct blocks (opener / image / prose) rather than one wall of text. Keep a consistent on-voice persona.",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    blueprint:
      "A vertical scroll-stopper: a short declarative hook in the first 1-2 lines, generous line breaks, one idea per line, a soft CTA or question to drive comments. Carousels: one idea per slide.",
  },
  {
    id: "x",
    label: "X (Twitter)",
    blueprint:
      "Tight and punchy. Single post ≤ 280 chars; threads number their parts and front-load the hook. Stat posts pair one metric with a crisp line. No fluff.",
  },
  {
    id: "instagram",
    label: "Instagram",
    blueprint:
      "Carousel slides (challenge → solution → result, one idea per slide) or a caption with a hook line, value, and a comment-to-DM CTA.",
  },
  {
    id: "standalone",
    label: "Standalone",
    blueprint: "Channel-agnostic; keep the structure clean and self-contained.",
  },
];

export interface ContentFormat {
  id: string;
  label: string;
  channel: string;
}

export const FORMATS: ContentFormat[] = [
  { id: "blog-pillar", label: "Pillar / Long-form", channel: "blog" },
  { id: "blog-section", label: "Blog Section", channel: "blog" },
  { id: "newsletter-section", label: "Newsletter Section", channel: "newsletter" },
  { id: "newsletter-success-block", label: "Success Block", channel: "newsletter" },
  { id: "newsletter-opener", label: "Editorial Opener", channel: "newsletter" },
  { id: "linkedin-post", label: "LinkedIn Post", channel: "linkedin" },
  { id: "linkedin-carousel", label: "LinkedIn Carousel", channel: "linkedin" },
  { id: "x-post", label: "X Post", channel: "x" },
  { id: "x-thread", label: "X Thread", channel: "x" },
  { id: "x-stat", label: "X Stat", channel: "x" },
  { id: "instagram-carousel", label: "Instagram Carousel", channel: "instagram" },
  { id: "instagram-caption", label: "Instagram Caption", channel: "instagram" },
  { id: "short-form", label: "Short-form", channel: "standalone" },
  { id: "long-form", label: "Long-form", channel: "standalone" },
];

const CHANNEL_IDS = new Set(CHANNELS.map((c) => c.id));
const FORMAT_IDS = new Set(FORMATS.map((f) => f.id));
export const DEFAULT_CHANNEL = "standalone";

export function isChannel(id: string): boolean {
  return CHANNEL_IDS.has(id);
}
export function isFormat(id: string): boolean {
  return FORMAT_IDS.has(id);
}
export function channelLabel(id: string): string {
  return CHANNELS.find((c) => c.id === id)?.label ?? id;
}
export function channelBlueprint(id: string): string {
  return CHANNELS.find((c) => c.id === id)?.blueprint ?? "";
}
export function formatLabel(id: string): string {
  return FORMATS.find((f) => f.id === id)?.label ?? id;
}
