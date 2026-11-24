/**
 * The paid things YouGrow uses on a brand's behalf, counted per brand per calendar month by the
 * usage meter (src/lib/plans/meter.ts). A resource is not a feature: nobody is granted it, every
 * brand that uses a feature uses it. A capped one stops at the brand's cap
 * (src/lib/plans/limits.ts); the others are counted only, for AI credits and the tiers.
 *
 * Adding one: an entry here and a meter at each place that spends it. Plan and usage lists it
 * with no page change. Pure and client safe, so pages can read it.
 */

export const RESOURCES = {
  /** Google searches Gemini runs to ground an answer (billed per search). */
  web_searches: {
    label: "Web searches for research",
    unit: "searches",
    capped: true,
    shownAs: null,
    purposes: [
      "brand_map_research",
      "situations",
      "situation_questions",
      "blog_research",
      "autopilot_research",
      "competitor_site",
      "trending",
      "enrichment",
    ],
  },
  /** Tokens every Gemini call uses (what AI credits will be worked out from), split by model too. */
  model_tokens: {
    label: "AI model use",
    unit: "tokens",
    capped: false,
    shownAs: null,
    purposes: [
      "brand_map_research",
      "situations",
      "situation_questions",
      "blog_research",
      "autopilot_research",
      "competitor_site",
      "trending",
      "enrichment",
      "blog_write",
      "fact_check",
      "seen_notes",
      "architect",
      "content_write",
      "edit_mode",
      "ebook",
      "templates",
      "brand_voice",
      "brand_kit",
      "brand_notes",
      "email_layout",
      "email_copy",
      "journeys",
      "lifecycle_lines",
      "competitor_analysis",
      "competitor_articles",
      "next_up",
      "judge",
      "post_feedback",
      "images",
      "vizzy_chat",
      "product_map",
      "other",
    ],
  },
  /** Images a model draws (blog heroes, post art, email images, ebook images, carousels). */
  images: {
    label: "Images made",
    unit: "images",
    capped: true,
    shownAs: null,
    purposes: ["blog_hero", "post_image", "email_block_image", "email_hero", "ebook_image", "customize_image", "carousel"],
  },
  /** Google results looked up through DataForSEO: shown, and capped, on the Next up row. */
  google_lookups: {
    label: "Google lookups",
    unit: "lookups",
    capped: false,
    shownAs: "next_up",
    purposes: ["get_from_google", "autopilot"],
  },
  /** Competitor articles a model read: shown, and capped, on the Competitor articles row. */
  competitor_reads: {
    label: "Competitor articles read",
    unit: "reads",
    capped: false,
    shownAs: "competitor_articles",
    purposes: ["competitor_articles"],
  },
  /** Workflows the autopilot drafted: shown, and capped, on the Article autopilot row. */
  autopilot_drafts: {
    label: "Autopilot drafts",
    unit: "drafts",
    capped: false,
    shownAs: "article_autopilot",
    purposes: ["autopilot"],
  },
} as const;

export type ResourceId = keyof typeof RESOURCES;
export const RESOURCE_IDS = Object.keys(RESOURCES) as ResourceId[];

/** What a resource was spent on: the feature that used it. */
export type ResourcePurpose<R extends ResourceId = ResourceId> = (typeof RESOURCES)[R]["purposes"][number];

/** The features that spend resources, as people know them. */
export const PURPOSE_LABELS: Record<ResourcePurpose, string> = {
  brand_map_research: "Brand map research",
  situations: "Finding buying situations",
  situation_questions: "Questions for a buying situation",
  blog_research: "Blog research",
  autopilot_research: "Autopilot research",
  competitor_site: "Finding a competitor's sitemap",
  trending: "Trending topics",
  enrichment: "Company enrichment",
  blog_write: "Writing blog articles",
  fact_check: "Fact checks",
  seen_notes: "What we've seen",
  architect: "Laying out workflows",
  content_write: "Writing posts and emails",
  edit_mode: "Edit mode",
  ebook: "eBooks",
  templates: "Templates",
  brand_voice: "Brand voice",
  brand_kit: "Brand kit",
  brand_notes: "Brand notes",
  email_layout: "Email layouts",
  email_copy: "Email copy",
  journeys: "Journeys",
  lifecycle_lines: "AI lines in emails",
  competitor_analysis: "Competitor analysis",
  competitor_articles: "Competitor articles",
  next_up: "Next up",
  judge: "Sorting what buyers ask",
  post_feedback: "Learning from posts",
  images: "Images",
  vizzy_chat: "Vizzy chat",
  product_map: "Learning your product",
  other: "Other",
  blog_hero: "Blog hero images",
  post_image: "Post images",
  email_block_image: "Email images",
  email_hero: "Email hero images",
  ebook_image: "eBook images",
  customize_image: "Customised images",
  carousel: "Carousels",
  get_from_google: "Get from Google",
  autopilot: "Autopilot",
};

/** What every place that would search says once a brand has used its web searches for the month. */
export const WEB_SEARCH_LIMIT_MESSAGE = "This brand has used its web searches for research this month.";

/** What every place that would draw says once a brand has used its images for the month. */
export const IMAGE_LIMIT_MESSAGE = "This brand has used its images for this month.";

export function isResourceId(r: string): r is ResourceId {
  return (RESOURCE_IDS as string[]).includes(r);
}
