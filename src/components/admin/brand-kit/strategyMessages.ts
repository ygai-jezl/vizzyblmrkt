import { errorText } from "@/components/admin/connect/api";

/**
 * What the Strategy tab says (Brand › Brand map › Strategy). Client safe. The help page quotes some
 * of these word for word (src/components/help/pages/brand-map.tsx, #strategy).
 */

export const STRATEGY_ERRORS: Record<string, string> = {
  brand_strategy_disabled: "The brand strategy isn't switched on in this environment.",
  competitor_finder_disabled: "The competitor finder isn't switched on in this environment.",
  strategy_competitors_disabled: "The strategy isn't joined to Competitors in this environment.",
  strategy_check_disabled: "The weekly strategy check isn't switched on in this environment.",
  strategy_results_disabled: "How it went isn't switched on in this environment.",
  no_month: "There's no strategy approved before this month began, so there's no month to add up yet.",
  no_suggestion: "That suggestion isn't waiting any more. It may have been watched or left out already.",
  competitors_unreadable: "Couldn't read your competitors just now, so nothing was approved. Try again.",
  strategy_changed: "The strategy was changed elsewhere since you opened it. It now shows what was saved: check it, then try again.",
  strategy_unreadable: "The strategy can't be read, so nothing can be changed. Start over to make a new one.",
  no_draft: "There's no draft yet. Press Propose with Vizzy first.",
  unknown_situation: "That buying situation isn't on the brand map any more.",
  no_model: "The AI model isn't set up in this environment, so Vizzy can't propose or find competitors.",
  no_brand_map: "Save the brand map first: the strategy is made from it.",
  nothing_to_propose: "Say what you are on Who you are, or add buying situations, first.",
  nothing_to_find: "Say what you are on Who you are first: the finder asks who buyers weigh instead of you.",
  propose_failed: "Vizzy didn't come back with a strategy it could check. Try again in a minute.",
  finder_quick_used: "This brand has used its one quick answer. The full competitor finder comes with plans that include it.",
  finder_not_included: "The full competitor finder isn't included for this brand.",
  finder_monthly_limit: "This brand has used its full finder runs for this month. They start again next month.",
  find_failed: "The finder got no answer from Google. Try again in a minute.",
  nothing_found: "Google's results didn't back any competitor this time, so your quick answer wasn't used. Try again later.",
  map_not_saved: "Save the brand map first, then add this to Who you are.",
  is_not_full: "What you are not is full on Who you are. Remove a line there first.",
  no_proposal: "That line isn't waiting any more.",
  already_decided: "Someone already said Add or No to that line.",
  too_few_focus: "Star 3 to 5 focus situations under Who it's for before you approve. With fewer on your map, star them all.",
  not_saved: "That couldn't be saved. Try again in a moment.",
  rate_limited: "That's a lot of runs at once. Try again in a few minutes.",
};

/** A readable message for an error from the Strategy tab's APIs. */
export function strategyErrorText(data: unknown): string {
  const code = (data as { error?: string } | null)?.error;
  return (code && STRATEGY_ERRORS[code]) || errorText(data);
}

export const PROPOSED_NOTE = "Vizzy proposed a strategy. Check it, then press Approve strategy.";
export const APPROVED_NOTE = "Approved. Articles, research, Next up and Vizzy now use this strategy.";
export const GAP_LABEL = "no proof yet";

/** After Propose with Vizzy: what code left out, said plainly. */
export function droppedNote(dropped: { claims: number } | undefined): string {
  const n = dropped?.claims ?? 0;
  return n ? ` ${n} ${n === 1 ? "claim was" : "claims were"} left out: their proof wasn't in what Vizzy read.` : "";
}

/** After a finder run. `joined`: the Strategy tab and Brand › Competitors share one list (STRATEGY_COMPETITORS_ENABLED). */
export function foundNote(found: number, gapSkipped = false, joined = false): string {
  const next = joined ? "Press Monitor on the ones to watch, or Not a competitor on the rest." : "Tick the ones to monitor.";
  const base = found ? `Found ${found} ${found === 1 ? "competitor" : "competitors"}. ${next}` : "No new competitors this time.";
  return gapSkipped ? `${base} ${GAP_SKIPPED_NOTE}` : base;
}

/** What Find competitors and Full search do for this brand, under the buttons on both doors. */
export function finderNote(f: { granted: boolean; quickUsed: boolean; used: number; limit: number | null }): string {
  const quick = `Quick: one answer from Google${f.granted ? "" : f.quickUsed ? ", used" : ", once"}.`;
  if (!f.granted) return quick;
  return `${quick} Full: three answers merged and checked, then a search that fits your business${f.limit !== null ? ` (${Math.max(0, f.limit - f.used)} left this month)` : ""}.`;
}

/** On Against your competitors, when a month had more reads than were looked at. */
export const TRUNCATED_NOTE = "Some months had more articles read than we count here, so these numbers may be a little low.";

/** After Monitor on a competitor the strategy names. */
export const monitoredNote = (name: string) => `${name} is on Brand › Competitors now.`;

/** After Monitor on a suggestion, on Brand › Competitors. */
export const watchingNote = (name: string) => `Watching ${name} now. It shows on the Strategy tab too.`;

/** After Not a competitor. */
export const notCompetitorNote = (name: string) => `${name} won't be suggested again.`;

/** A full run's last search couldn't run, but what the others found was kept. */
export const GAP_SKIPPED_NOTE = "The search that fits your business didn't run: this brand has used its web searches for research this month.";

/** After approving, when some stars couldn't be changed on Buying situations. */
export function starsNotUpdatedNote(situations: string[]): string {
  return `Approved, but these stars didn't change on Buying situations: ${situations.map((s) => `"${s}"`).join(", ")}. Star them there by hand.`;
}
