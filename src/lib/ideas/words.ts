import type { ChipTone } from "@/components/admin/people/Chip";
import { IDEA_STATUSES, type IdeaStatus } from "@/lib/types/campaign";

/**
 * The words and colours of ideas (LAUNCH_IDEAS_ENABLED). Pure and client safe. The screens still
 * say launch while the wording switch is off; a message a help page quotes is written out here
 * as a literal, so the help test can find it.
 */

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  exploring: "Exploring",
  testing: "Testing",
  validated: "Validated",
  launched: "Launched",
  parked: "Parked",
  killed: "Killed",
};

/** Each status's chip: one colour each, so the list reads at a glance. */
export const IDEA_STATUS_TONE: Record<IdeaStatus, ChipTone> = {
  exploring: "neutral",
  testing: "blue",
  validated: "green",
  launched: "violet",
  parked: "amber",
  killed: "red",
};

export const IDEA_STATUS_OPTIONS = IDEA_STATUSES.map((s) => ({ value: s, label: IDEA_STATUS_LABEL[s], tone: IDEA_STATUS_TONE[s] }));

export const JUST_A_LIST = "Just a list";

/** What the card and New launch say when something goes wrong, or worked only in part. */
export const IDEA_MESSAGES = {
  /** New launch: the launch exists, the second call (its hypothesis) failed. */
  hypothesisNotSaved: "Your launch is made. Add the hypothesis on its Overview.",
  notSaved: "Couldn't save that. Try again.",
  notLaunched: "Set the status to Launched first, then hand it off.",
  productGone: "That product isn't connected any more. Pick another one.",
  closeFailed: "The status is saved, but the waitlist didn't close. Try again, or use Archive launch on the Settings tab.",
} as const;

/** An error code from the idea route, in words. */
export function ideaErrorText(code: unknown): string {
  if (code === "not_launched") return IDEA_MESSAGES.notLaunched;
  if (code === "product_not_found") return IDEA_MESSAGES.productGone;
  return IDEA_MESSAGES.notSaved;
}
