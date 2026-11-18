import { isAiDraftKeptEnabled } from "@/lib/content/create/flags";
import { isEditModeVizzyLearningEnabled } from "@/lib/content/editor/flags";

/**
 * Distribute switches for post results and learning from post edits. Server only, read at
 * runtime: the Distribute page passes what they decide to the browser as props. Each is off
 * unless "true" (listed "false" in apphosting.yaml, turned on per deployment).
 */

/**
 * Each published LinkedIn page or X post shows its numbers on its Distribute card. Needs
 * DISTRIBUTE_CLOSED_LOOP_ENABLED, which collects them. Off: the card is exactly as before.
 */
export function isPostResultsEnabled(): boolean {
  return (
    process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED === "true" &&
    process.env.DISTRIBUTE_POST_RESULTS_ENABLED === "true"
  );
}

/**
 * Vizzy learns how a person edits its LinkedIn and X posts (the words they changed, sent to
 * Memory Bank once the post is published) and uses it the next time it drafts one for them.
 * Needs CONTENT_AI_DRAFT_KEPT_ENABLED (the draft to compare with) and Edit mode's learning
 * switch (Memory Bank, and the panel where people see and forget what Vizzy learned).
 */
export function isLearnFromPostEditsEnabled(): boolean {
  return (
    isAiDraftKeptEnabled() &&
    isEditModeVizzyLearningEnabled() &&
    process.env.DISTRIBUTE_LEARN_FROM_EDITS_ENABLED === "true"
  );
}

/**
 * Keep every post number the platforms give: X reposts, quotes and bookmarks apart (they are
 * summed into shares for the reward, which doesn't change), LinkedIn's own engagement rate, and
 * the numbers auto-plug polls before the first stats poll. Off: only what was kept before.
 */
export function isPostMetricsDetailEnabled(): boolean {
  return process.env.POST_METRICS_DETAIL_ENABLED === "true";
}
