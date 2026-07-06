/**
 * Shared constants + flags for author-time on-brand SOCIAL POST image generation
 * (Create node inspector). Pure + client-safe (no server imports) so the inspector can
 * import the aspect/style options and the UI flag, while the engine/route import the
 * Gemini aspect map + the server flag.
 */

/** Operator-facing social aspect ratios (native to the feeds). */
export const SOCIAL_ASPECTS = ["1:1", "4:5", "1.91:1"] as const;
export type SocialAspect = (typeof SOCIAL_ASPECTS)[number];

/**
 * Operator-facing image STYLE presets. The selected style's `keywords` are injected into
 * the image-generation prompt (content.social_image_brief) so the model renders in that
 * aesthetic; `label` + `hint` drive the inspector dropdown.
 */
export const SOCIAL_IMAGE_STYLES = [
  {
    id: "minimalist",
    label: "Minimalist & Clean",
    hint: "Tech-modern — B2B SaaS, fintech, productivity (Apple / Notion).",
    keywords:
      "minimalist, clean, Scandinavian design, high negative space, restricted palette with a single accent colour, sharp focus, flat studio lighting, crisp, elegant",
  },
  {
    id: "vibrant",
    label: "Vibrant & Playful",
    hint: "Friendly startup — EdTech, community & kids' apps (Duolingo / Slack).",
    keywords:
      "playful, vibrant saturated colour palette, rounded shapes, 3D claymation or flat vector illustration, cheerful, friendly, bold shapes",
  },
  {
    id: "earthy",
    label: "Earthy & Organic",
    hint: "Sustainable — skincare, wellness, organic food (Aesop / Patagonia).",
    keywords:
      "organic, earthy muted tones (terracotta, sage green, warm beige), soft natural sunlight, matte texture, rustic, bohemian, diffused light",
  },
  {
    id: "retro",
    label: "Retro & Vintage",
    hint: "Nostalgic — craft breweries, apparel, music brands.",
    keywords:
      "vintage film photography, 35mm film grain, faded 1970s–80s warm colour grading, subtle chromatic aberration, nostalgic, Polaroid look",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk & Futurism",
    hint: "Edgy tech — Web3, gaming, AI startups, nightlife.",
    keywords:
      "cyberpunk, neon pink / cyan / purple glow, synthwave, futuristic, holographic elements, dark ambient lighting, urban environment",
  },
  {
    id: "luxury",
    label: "Luxury & Editorial",
    hint: "Premium — jewellery, high fashion, hospitality, real estate.",
    keywords:
      "luxury editorial, high fashion photography, dramatic chiaroscuro lighting, deep shadows, rich textures (velvet, marble, gold), opulent, cinematic framing",
  },
  {
    id: "brutalist",
    label: "Brutalist & Anti-Design",
    hint: "Raw & underground — streetwear, festivals, art galleries.",
    keywords:
      "brutalist aesthetic, raw concrete texture, harsh primary colours, glitch art, industrial, anti-design, stark contrast, collage style",
  },
  {
    id: "handcrafted",
    label: "Handcrafted & Artisan",
    hint: "Human touch — handmade goods, bakeries, boutiques.",
    keywords:
      "hand-drawn, watercolour washes, linocut print texture, chalkboard sketch, artisanal, sketchy ink lines, human touch, rustic charm",
  },
  {
    id: "cinematic",
    label: "Corporate Cinematic",
    hint: "Inspiring & grand — VC, consulting, enterprise software.",
    keywords:
      "cinematic corporate photography, golden hour lighting, wide-angle, epic scale, lens flare, high production value, professional, inspiring, commercial",
  },
  {
    id: "popart",
    label: "Pop Art & Comic Bold",
    hint: "Loud & expressive — agencies, youth brands, entertainment.",
    keywords:
      "pop art style, Roy Lichtenstein aesthetic, comic book illustration, Ben-Day halftone dots, thick bold outlines, saturated primary colours",
  },
] as const;

export type SocialImageStyle = (typeof SOCIAL_IMAGE_STYLES)[number]["id"];

/** The style ids as a tuple, for zod enum validation on the route. */
export const SOCIAL_IMAGE_STYLE_IDS = SOCIAL_IMAGE_STYLES.map((s) => s.id) as [
  SocialImageStyle,
  ...SocialImageStyle[],
];

/** Default style for a fresh control (professional, photographic). */
export const DEFAULT_SOCIAL_IMAGE_STYLE: SocialImageStyle = "cinematic";

/** Look up a style preset by id (falls back to the first preset on an unknown id). */
export function socialImageStyle(id: string) {
  return SOCIAL_IMAGE_STYLES.find((s) => s.id === id) ?? SOCIAL_IMAGE_STYLES[0];
}

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
