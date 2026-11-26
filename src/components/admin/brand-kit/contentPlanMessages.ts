import { errorText } from "@/components/admin/connect/api";

/**
 * What the Content plan section says (Brand › Brand map › Strategy). Client safe. The help page
 * quotes some of these word for word (src/components/help/pages/brand-map.tsx, #content-plan).
 */

export const PLAN_ERRORS: Record<string, string> = {
  content_strategy_disabled: "The content plan isn't switched on in this environment.",
  plan_changed: "The plan was changed elsewhere since you opened it. It now shows what was saved: check it, then try again.",
  plan_unreadable: "The plan can't be read, so nothing can be changed. Start over to make a new one.",
  no_plan: "There's no plan yet. Press Make the plan first.",
  no_draft: "There's nothing new to approve. Make the plan again, or change it first.",
  no_brand_map: "Save the brand map first: the plan is made from its questions.",
  nothing_to_plan: "Add questions to the brand map first: the plan merges them into articles.",
  plan_too_large: "The plan is too large to save. Remove questions you don't need from the brand map, then make it again.",
  plan_full: "The plan holds 400 slots already. Join two slots first.",
  slot_single: "That slot has one question, so there's nothing to split.",
  slot_full: "One slot holds 8 questions at most. Split one out first.",
  no_slot: "That slot isn't in the plan any more.",
  no_pillar: "That pillar isn't in the plan any more.",
  no_pick: "That pick isn't on the roadmap any more.",
  unknown_week: "That week isn't in the plan.",
  rate_limited: "That's a lot of plans at once. Try again in a few minutes.",
};

/** A readable message for an error from the Content plan's APIs. */
export function planErrorText(data: unknown): string {
  const code = (data as { error?: string } | null)?.error;
  return (code && PLAN_ERRORS[code]) || errorText(data);
}

export const MADE_NOTE = "Your content plan is ready. Check the pillars and the next weeks, then press Approve plan.";
export const PLAN_APPROVED_NOTE = "Approved. Next up now takes 3 of every 4 picks from this plan.";
export const PLAN_APPROVED_QUIET_NOTE = "Approved. This is the plan your team works from now.";
export const NOT_ARTICLES_LABEL = "Not articles (done by hand for now)";

/** After Make the plan: what it couldn't do, said plainly. */
export function madeNote(notes: { lookupsAsked?: number; byMeaning?: boolean; leftOut?: number } | undefined): string {
  const parts = [MADE_NOTE];
  if (notes && notes.byMeaning === false) parts.push("Questions were merged by their words only this time, as matching by meaning wasn't available.");
  if (notes?.lookupsAsked) parts.push(`Google was asked about ${notes.lookupsAsked} ${notes.lookupsAsked === 1 ? "question" : "questions"}: making the plan again later uses what comes back.`);
  if (notes?.leftOut) parts.push(`${notes.leftOut} smaller ${notes.leftOut === 1 ? "slot was" : "slots were"} left out past the limit of 400.`);
  return parts.join(" ");
}
