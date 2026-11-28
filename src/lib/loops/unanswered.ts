import { isAgentRecordEnabled } from "@/lib/agentRecord/flags";
import type { LoopKind } from "./registry";

/**
 * The kinds whose made things no path lets a person answer yet (learning loops step 5, 4.4 of the
 * plan for steps 4 and 5): YouGrow counts them made, but nothing counts them kept, edited or
 * declined, so every one would read as unused. Their unused count is left out (unusedForWeek, so
 * the heartbeat and get_learning leave it out too), and get_learning gives them no shares, only
 * their counts and why (`unanswered`). A kind leaves this list once a save counts its answers.
 *
 * Image kinds aren't here: votes answer them, and their versions say what went unused. Kinds that
 * count made nowhere (a pick inside a sender, a rule) need no line. The kinds only the agent
 * record answers join them while it is off (RECORD_ONLY, unansweredWhy).
 */
export const UNANSWERED: Partial<Record<LoopKind, string>> = {
  send_time: "Each email goes out at the time YouGrow picks, and nothing a person does answers that time.",
  auto_plug: "The comment posts by itself once its post is live, so no one keeps, changes or turns it down.",
  templates: "A template is copied from a piece your team picked, and nothing counts what they do with it next.",
  content_brief: "A brief only steers the piece written from it, which counts under its own kind.",
  blog_research: "Research goes into the article's brief, and nothing records which facts and sources your team kept or cut.",
  autopilot_research: "Research goes into the article's brief, and nothing records which facts and sources your team kept or cut.",
  architect: "Nothing records the pieces your team adds or deletes after a workflow is laid out.",
  ebook: "eBook chapters keep no AI original, so nothing counts how your team changed them.",
  onboarding: "The founder keeps, changes or removes each answer on the page, and that choice isn't counted.",
  brand_strategy: "The strategy keeps the stars and edits a person made, but none of them counts as an answer yet.",
  strategy_check: "The weekly check opens or changes rows on the strategy, and nothing counts what a person does with them.",
  competitor_find: "A name a person marks Not a competitor is kept on the strategy, but isn't counted as an answer.",
  situations: "A situation a person dismisses is kept on the brand map, but isn't counted as an answer.",
  situation_questions: "A question a person dismisses stays on the brand map, but isn't counted as an answer.",
  content_strategy: "The plan keeps each pillar a person renamed and each slot they split or joined, and none of it counts as an answer.",
  judge: "The questions your team moves between trays are kept on the Learned list, and aren't counted against the sorting.",
  enrichment: "A person corrects a wrong company detail where it is shown, and that isn't counted.",
  journeys: "A journey draft is saved over by your team's edits, so no answer is kept to count.",
  trending: "It reports what your industry is talking about, and nothing a person does answers it.",
  seen_notes: "A note your team takes out of an article is kept on its brief, but isn't counted as an answer.",
  competitor_site: "It finds a competitor's sitemap, and nothing a person does answers it.",
  competitor_analysis: "It sums up a competitor's own pages, and nothing a person does answers it.",
  competitor_articles: "It records what each competitor article says, and nothing a person does answers it.",
  next_action: "The card keeps what happened to each step, but those outcomes aren't counted as answers.",
  email_copy: "Its words go back to the editor with no stamp token, so the save can't say they were these.",
  email_layout: "Its layout goes back to the editor with no stamp token, so the save can't say it was this one.",
  content_angle: "Its angle goes back to the wizard with no stamp token, so the save can't say it was this one.",
  edit_mode: "Vizzy's words go back to the editor with no stamp token, so the save can't say they were these.",
  "canvas.person_plan": "Staff approve each plan, but the plan keeps no stamp, so the approval isn't counted.",
  "canvas.brand_map": "Vizzy's changes to the brand map keep no stamp, so a dismissal isn't counted against them.",
};

/**
 * The kinds whose only answer is the agent record's close (ADR-0026: its lines that count at the
 * transition, for kinds no other path answers): Vizzy's journeys and lifecycle journeys, a
 * journey's own style, and the email and image style suggestions. While AGENT_RECORD_ENABLED is
 * off no record keeps their stamp, so nothing can answer them, and they read as unanswered. The
 * other transition lines need no place here: Vizzy's notes count no made while the record is off
 * (src/lib/brandNotes/agentApi.ts), and the product map counts none at all.
 * src/lib/loops/unanswered.test.ts checks the list against the record's lines.
 */
export const RECORD_ONLY: readonly LoopKind[] = ["canvas.journey", "canvas.lifecycle", "canvas.journey_style", "canvas.email_style", "canvas.image_style"];

/** Why a RECORD_ONLY kind reads as unanswered while the agent record is off. */
export const RECORD_OFF_WHY = "Its answer is kept on the agent record, which is off on this copy.";

/**
 * Why no path counts an answer to this kind's made things yet (UNANSWERED, or RECORD_OFF_WHY for a
 * RECORD_ONLY kind while the agent record is off), or null when one does. Reads the switch each
 * call, so the heartbeat and get_learning follow the copy as it is now.
 */
export function unansweredWhy(kind: string): string | null {
  if (Object.prototype.hasOwnProperty.call(UNANSWERED, kind)) return UNANSWERED[kind as LoopKind] ?? null;
  return !isAgentRecordEnabled() && (RECORD_ONLY as readonly string[]).includes(kind) ? RECORD_OFF_WHY : null;
}

/** Whether no path counts an answer to this kind's made things yet. */
export function isUnanswered(kind: string): boolean {
  return unansweredWhy(kind) !== null;
}
