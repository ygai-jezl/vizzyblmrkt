import { isBrandMapEnabled } from "@/lib/brandMap/flags";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";

/**
 * Switches for the brand strategy (Brand › Brand map › Strategy). Each is off unless "true":
 * listed "false" in apphosting.yaml and turned on per deployment. Server switches: the page
 * passes what is on to its client components. Off: nothing reads or writes a strategy, and the
 * writer, research and Next up work exactly as before.
 */

/** The record, the Strategy tab, Propose with Vizzy and Approve. Needs BRAND_MAP_ENABLED. */
export function isBrandStrategyEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_STRATEGY_ENABLED === "true";
}

/** Client mirror (build-time): the Strategy section on the Brand map help page. */
export function isBrandStrategyUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_STRATEGY_ENABLED === "true";
}

/** The competitor finder: grounded Google searches for who buyers weigh instead. Needs the strategy. */
export function isCompetitorFinderEnabled(): boolean {
  return isBrandStrategyEnabled() && process.env.COMPETITOR_FINDER_ENABLED === "true";
}

/** Vizzy's get_brand_strategy: reads the approved strategy (never changes it). Needs the strategy. */
export function isBrandStrategyChatEnabled(): boolean {
  return isBrandStrategyEnabled() && process.env.BRAND_STRATEGY_CHAT_ENABLED === "true";
}

/**
 * Strategy and Competitors joined: one competitor list behind two doors (the Strategy tab and
 * Brand › Competitors), a group on each watched competitor, Not a competitor for the finder, and
 * what their articles say in Propose and on the tab. Needs the strategy and COMPETITORS_ENABLED.
 * Off: the tab lists only what the finder found, and Propose copies the watched ones once.
 */
export function isStrategyCompetitorsEnabled(): boolean {
  return isBrandStrategyEnabled() && isCompetitorsEnabled() && process.env.STRATEGY_COMPETITORS_ENABLED === "true";
}

/**
 * The weekly strategy check: once a week, each approved strategy is set against what the watched
 * competitors published, and one Review row asks for a look only when something material changed
 * (new articles on a focus situation, a focus situation newly a gap, or an alternative they keep
 * naming). Vizzy reads it with the live competitor list. Needs the join and
 * COMPETITOR_ARTICLES_ENABLED. Off: nothing is checked, and Review and Vizzy are as before.
 */
export function isStrategyCheckEnabled(): boolean {
  return isStrategyCompetitorsEnabled() && isCompetitorArticlesEnabled() && process.env.STRATEGY_CHECK_ENABLED === "true";
}
