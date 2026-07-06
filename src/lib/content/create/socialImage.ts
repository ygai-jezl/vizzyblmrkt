/**
 * Shared constants + flags for author-time on-brand SOCIAL POST image generation
 * (Create node inspector). Pure + client-safe (no server imports) so the inspector can
 * import the aspect/style options and the UI flag, while the engine/route import the
 * Gemini aspect map + the server flag.
 */

/** Operator-facing social aspect ratios (native to the feeds). */
export const SOCIAL_ASPECTS = ["1:1", "4:5", "1.91:1"] as const;
export type SocialAspect = (typeof SOCIAL_ASPECTS)[number];

/** Operator-facing image styles. */
export const SOCIAL_IMAGE_STYLES = ["photographic", "illustration", "abstract"] as const;
export type SocialImageStyle = (typeof SOCIAL_IMAGE_STYLES)[number];

/** Channels that get a post-image control (matches src/lib/content/channels.ts ids). */
export const SOCIAL_IMAGE_CHANNELS = ["linkedin", "x", "instagram"] as const;
export function isSocialImageChannel(channel: string): boolean {
  return (SOCIAL_IMAGE_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Map an operator social aspect to the NEAREST Gemini-supported ratio — Gemini's image
 * model supports 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9 (NOT 4:5 or 1.91:1), so we
 * approximate portrait 4:5 → 3:4 and landscape 1.91:1 → 16:9.
 */
export const SOCIAL_ASPECT_TO_GEMINI: Record<SocialAspect, string> = {
  "1:1": "1:1",
  "4:5": "3:4",
  "1.91:1": "16:9",
};

/** Sensible default aspect per channel (operator can override). */
export function defaultAspectForChannel(channel: string): SocialAspect {
  return channel === "x" ? "1.91:1" : "1:1";
}

/** Server flag — the generate route 503s unless this is on. */
export function isSocialImageEnabled(): boolean {
  return process.env.CREATE_SOCIAL_IMAGE_ENABLED === "true";
}

/** Client mirror — the inspector only shows the control when this is on. */
export function isSocialImageUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SOCIAL_IMAGE_ENABLED === "true";
}
