/**
 * Which sidebar sections wait under Coming up (ONBOARDING_ENABLED, nav v2 phase 2). Pure and
 * client safe, so the sidebar (client) and the routes (server) share it.
 *
 * buildNav (model.ts) stays whole: ⌘K and the Vizzy panel still list every section. Only the
 * sidebar passes its sections through `pathSections`, and only for a brand that told Vizzy about
 * itself on the welcome (`tenant.sidebarReveal`). Without that, the sidebar is exactly as before.
 */

import type { NavItem, NavKey, NavSection } from "./model";

/** The sections that can wait under Coming up, in the sidebar's order (Grow, then Understand). */
export const REVEALABLE = ["content", "products", "journeys", "audience", "insights"] as const;
export type RevealKey = (typeof REVEALABLE)[number];

/**
 * Every sidebar section picks a rule, so a new NavKey fails typecheck until it does. "always"
 * shows from the start (Home, Review, Ideas, Brand, Settings); "reveal" can wait under Coming up.
 */
export const REVEAL_RULE: Record<NavKey, "always" | "reveal"> = {
  home: "always",
  review: "always",
  launches: "always",
  content: "reveal",
  products: "reveal",
  journeys: "reveal",
  audience: "reveal",
  insights: "reveal",
  brand: "always",
  settings: "always",
};

export function isRevealKey(value: unknown): value is RevealKey {
  return typeof value === "string" && (REVEALABLE as readonly string[]).includes(value);
}

/**
 * Keys as stored or sent (plain strings, maybe from an older or newer build): the revealable ones,
 * once each, in the sidebar's order. Anything else is dropped, so a rollback never breaks a read.
 */
export function revealKeysOf(raw: readonly unknown[]): RevealKey[] {
  const seen = new Set(raw.filter(isRevealKey));
  return REVEALABLE.filter((k) => seen.has(k));
}

export interface PathView {
  /** The sidebar's sections with the waiting items left out; a titled group left empty is dropped. */
  sections: NavSection[];
  /** The items waiting under Coming up, in the sidebar's order: Grow's, then Understand's. */
  comingUp: NavItem[];
}

/**
 * The sidebar for a brand with Coming up: `shown` is every revealable section this brand shows
 * ("all" once every stage is running). The page in view always shows. Items keep their order, and
 * Understand loses its heading when nothing in it shows.
 */
export function pathSections(
  sections: readonly NavSection[],
  shown: ReadonlySet<string> | "all",
  activeKey: NavKey | null,
): PathView {
  if (shown === "all") return { sections: [...sections], comingUp: [] };
  const comingUp: NavItem[] = [];
  const out: NavSection[] = [];
  for (const section of sections) {
    const items = section.items.filter((item) => {
      const waits = REVEAL_RULE[item.key] === "reveal" && !shown.has(item.key) && item.key !== activeKey;
      if (waits) comingUp.push(item);
      return !waits;
    });
    if (section.title && items.length === 0) continue;
    out.push({ ...section, items });
  }
  return { sections: out, comingUp };
}

/**
 * The sections the sidebar shows for a brand with Coming up: what the page was drawn with
 * (`drawn`, from the layout), what the growth route found since (`fetched`) and what was opened
 * here, or "all" once every stage is running. Null without Coming up: today's sidebar.
 */
export function shownSections(
  drawn: { shown: readonly string[] } | undefined,
  live: { fetched: readonly string[] | null; allRunning: boolean },
  opened: readonly string[],
): ReadonlySet<string> | "all" | null {
  if (!drawn) return null;
  if (live.allRunning) return "all";
  return new Set(revealKeysOf([...drawn.shown, ...(live.fetched ?? []), ...opened]));
}

/**
 * A waiting section whose page is in view (reached by ⌘K or a link): the sidebar shows it, and
 * records it like Open early, so it doesn't hide again when you leave. Null otherwise.
 */
export function waitingInView(shown: ReadonlySet<string> | "all" | null, activeKey: NavKey | null): RevealKey | null {
  if (!shown || shown === "all" || !isRevealKey(activeKey) || shown.has(activeKey)) return null;
  return activeKey;
}
