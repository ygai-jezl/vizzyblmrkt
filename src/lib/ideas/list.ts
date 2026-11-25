import { IDEA_STATUSES, type Campaign, type IdeaStatus } from "@/lib/types/campaign";

/**
 * The launches list's status filter (LAUNCH_IDEAS_ENABLED): `?idea=<status|none|list>`, applied in
 * memory to the rows the page already reads. `?status` stays the Active and Archived tabs.
 * "none" is a launch nobody has given a status (every launch made before ideas), "list" one marked
 * Just a list.
 */

export type IdeaFilter = IdeaStatus | "none" | "list";

/** How many launches compare at once (src/lib/ideas/compare.ts). Here so client code can read it. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

export const IDEA_FILTERS: readonly IdeaFilter[] = [...IDEA_STATUSES, "none", "list"];

/** Where one launch sits in the filter. */
export function ideaFilterOf(c: Pick<Campaign, "idea">): IdeaFilter {
  if (c.idea?.justAList) return "list";
  return c.idea?.status ?? "none";
}

/** The filter a query value names, or null for anything else (no filter). */
export function parseIdeaFilter(raw: string | string[] | undefined): IdeaFilter | null {
  return typeof raw === "string" && (IDEA_FILTERS as readonly string[]).includes(raw) ? (raw as IdeaFilter) : null;
}

/** How many launches sit in each part of the filter. */
export function ideaFilterCounts(rows: ReadonlyArray<Pick<Campaign, "idea">>): Record<IdeaFilter, number> {
  const counts = Object.fromEntries(IDEA_FILTERS.map((f) => [f, 0])) as Record<IdeaFilter, number>;
  for (const r of rows) counts[ideaFilterOf(r)] += 1;
  return counts;
}
