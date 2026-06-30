import { channelBlueprint, isChannel } from "./channels";

/**
 * Modular Transformation Matrix — maps a source block ROLE × target CHANNEL to the
 * channel-native spoke format + a transform hint. Encodes the Pillar→spoke matrix
 * (Contrarian Hook → Editorial Opener / LinkedIn Hook; Data Point → Success Block /
 * X Stat; Case Study → Testimonial / Carousel; CTA → Button / Comment Opt-in) +
 * extensions. Pure + client-safe.
 */
export interface Transformation {
  blockType: string;
  channel: string;
  format: string;
  hint: string;
}

export const TRANSFORMATIONS: Transformation[] = [
  // Hook
  { blockType: "hook", channel: "newsletter", format: "newsletter-opener", hint: "A punchy editorial opener with an eyebrow title to drive opens." },
  { blockType: "hook", channel: "linkedin", format: "linkedin-post", hint: "A vertical scroll-stopper: a short declarative statement that challenges an assumption in the first line." },
  { blockType: "hook", channel: "x", format: "x-post", hint: "A single declarative hook, <= 280 chars." },
  // Data point
  { blockType: "data-point", channel: "newsletter", format: "newsletter-success-block", hint: "A success-metrics callout with a bold header." },
  { blockType: "data-point", channel: "x", format: "x-stat", hint: "A concise stat post: the metric + one crisp line." },
  { blockType: "data-point", channel: "linkedin", format: "linkedin-post", hint: "Lead with the metric, then the takeaway." },
  // Case study
  { blockType: "case-study", channel: "newsletter", format: "newsletter-section", hint: "A short customer narrative or a stylized testimonial quote." },
  { blockType: "case-study", channel: "instagram", format: "instagram-carousel", hint: "A carousel: challenge -> solution -> result, one idea per slide." },
  { blockType: "case-study", channel: "linkedin", format: "linkedin-carousel", hint: "A carousel or story post: before -> change -> result." },
  // CTA
  { blockType: "cta", channel: "newsletter", format: "newsletter-section", hint: "A prominent CTA block with a clear next step." },
  { blockType: "cta", channel: "instagram", format: "instagram-caption", hint: "A comment-to-DM opt-in (e.g. comment a keyword to receive it)." },
  { blockType: "cta", channel: "linkedin", format: "linkedin-post", hint: "A soft CTA or question that drives comments." },
  // Takeaway list
  { blockType: "takeaway-list", channel: "x", format: "x-thread", hint: "A numbered thread, one point per tweet." },
  { blockType: "takeaway-list", channel: "linkedin", format: "linkedin-post", hint: "A scannable list post, one idea per line." },
  // Quote / testimonial
  { blockType: "quote-testimonial", channel: "newsletter", format: "newsletter-section", hint: "A stylized quote block with attribution." },
  { blockType: "quote-testimonial", channel: "x", format: "x-post", hint: "A standalone quote post." },
];

const DEFAULT_FORMAT: Record<string, string> = {
  blog: "blog-section",
  newsletter: "newsletter-section",
  linkedin: "linkedin-post",
  x: "x-post",
  instagram: "instagram-caption",
  standalone: "short-form",
};

/** The transformation for a (blockType, channel), or a sensible channel default. */
export function transformFor(blockType: string, channel: string): Transformation {
  const hit = TRANSFORMATIONS.find((t) => t.blockType === blockType && t.channel === channel);
  if (hit) return hit;
  return {
    blockType,
    channel,
    format: DEFAULT_FORMAT[channel] ?? "short-form",
    hint: isChannel(channel) ? channelBlueprint(channel) : "Keep it native to the channel.",
  };
}
