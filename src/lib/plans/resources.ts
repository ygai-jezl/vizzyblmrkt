/**
 * The paid things YouGrow uses on a brand's behalf, counted per brand per calendar month by the
 * usage meter (src/lib/plans/meter.ts) and capped like a costly feature (src/lib/plans/limits.ts).
 * A resource is not a feature: nobody is granted it, every brand that uses a feature uses it.
 *
 * Adding one: an entry here, its switch in meter.ts, and a meter passed at each place that spends
 * it. Plan and usage lists it with no page change. Pure and client safe, so pages can read it.
 */

export const RESOURCES = {
  /** Google searches Gemini runs to ground an answer (billed per search). */
  web_searches: {
    label: "Web searches for research",
    unit: "searches",
    capped: true,
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
};

/** What every place that would search says once a brand has used its web searches for the month. */
export const WEB_SEARCH_LIMIT_MESSAGE = "This brand has used its web searches for research this month.";

export function isResourceId(r: string): r is ResourceId {
  return (RESOURCE_IDS as string[]).includes(r);
}
