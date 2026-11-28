import type { DeckStage, LayoutKey, SectionKey } from "./types";

/**
 * The 8 slide layouts as data: which fields each one shows and how many. A slide keeps every field
 * it has whatever its layout (a person can switch back), and the layout decides what is drawn.
 * Each slide draws at 1280 by 720 CSS pixels. Pure and client safe.
 */

export interface LayoutSpec {
  key: LayoutKey;
  /** Points shown: the cover's one line, a statement's one supporting point, three points. */
  points: number;
  /** Two columns of up to 4 rows. */
  compare: boolean;
  /** People with a name, role and one line. */
  people: number;
  /** Number blocks shown. */
  blocks: number;
  /** A series block drawn as a line chart. */
  chart: boolean;
}

/** Words on a slide (not its notes), at most: the too many words check. */
export const MAX_WORDS = 30;

/** The slide's size, in CSS pixels: 13.333 by 7.5 inches at 96 to the inch. */
export const SLIDE_SIZE = { width: 1280, height: 720 } as const;

export const LAYOUTS: Record<LayoutKey, LayoutSpec> = {
  cover: { key: "cover", points: 1, compare: false, people: 0, blocks: 0, chart: false },
  statement: { key: "statement", points: 1, compare: false, people: 0, blocks: 0, chart: false },
  three_points: { key: "three_points", points: 3, compare: false, people: 0, blocks: 0, chart: false },
  big_number: { key: "big_number", points: 1, compare: false, people: 0, blocks: 3, chart: false },
  chart: { key: "chart", points: 1, compare: false, people: 0, blocks: 2, chart: true },
  compare: { key: "compare", points: 0, compare: true, people: 0, blocks: 0, chart: false },
  team: { key: "team", points: 0, compare: false, people: 4, blocks: 0, chart: false },
  // Up to 3 points on what it buys, and one line on where it gets you.
  ask: { key: "ask", points: 4, compare: false, people: 0, blocks: 1, chart: false },
};

/** Points a layout shows on this slide: a seed deck's product slide takes 4. */
export function pointsCap(layout: LayoutKey, section: SectionKey, stage: DeckStage): number {
  if (layout === "three_points" && section === "product" && stage === "seed") return 4;
  return LAYOUTS[layout].points;
}
