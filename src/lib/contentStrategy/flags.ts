import { isBrandStrategyEnabled } from "@/lib/brandStrategy/flags";

/**
 * Switches for the content strategy (Brand › Brand map › Strategy › Content plan). Each is off
 * unless "true": listed "false" in apphosting.yaml and turned on per deployment. Server switches:
 * the page passes what is on to its client components. Off: nothing reads or writes a content
 * plan, and Next up, the autopilot and the writer work exactly as before.
 */

/** The record, the Content plan section, Make the plan and Approve plan. Needs BRAND_STRATEGY_ENABLED. */
export function isContentStrategyEnabled(): boolean {
  return isBrandStrategyEnabled() && process.env.CONTENT_STRATEGY_ENABLED === "true";
}

/** Client mirror (build-time): the Content plan section on the Brand map help page. */
export function isContentStrategyUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONTENT_STRATEGY_ENABLED === "true";
}

/**
 * Next up takes 3 of 4 candidates from the approved plan's roadmap, the autopilot fills its slots,
 * and an article written for a slot is briefed with the slot's other questions. Needs the plan.
 */
export function isContentStrategyNextUpEnabled(): boolean {
  return isContentStrategyEnabled() && process.env.CONTENT_STRATEGY_NEXT_UP_ENABLED === "true";
}

/** Vizzy's get_content_strategy: reads the approved plan (never changes it). Needs the plan. */
export function isContentStrategyChatEnabled(): boolean {
  return isContentStrategyEnabled() && process.env.CONTENT_STRATEGY_CHAT_ENABLED === "true";
}
