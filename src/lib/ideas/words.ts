import type { ChipTone } from "@/components/admin/people/Chip";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import { IDEA_STATUSES, type Idea, type IdeaStatus } from "@/lib/types/campaign";

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

/**
 * The same messages while launches are called ideas (isIdeaWordsEnabled()). Written out in full
 * rather than built from ideaWord(), so a help page can quote either set and the help test still
 * finds it in the source.
 */
export const IDEA_MESSAGES_AS_IDEAS: Record<keyof typeof IDEA_MESSAGES, string> = {
  hypothesisNotSaved: "Your idea is made. Add the hypothesis on its Overview.",
  notSaved: IDEA_MESSAGES.notSaved,
  notLaunched: IDEA_MESSAGES.notLaunched,
  productGone: IDEA_MESSAGES.productGone,
  closeFailed: "The status is saved, but the waitlist didn't close. Try again, or use Archive idea on the Settings tab.",
};

/** The messages in the words in use: `ideas` is useWords().ideas, or isIdeaWordsEnabled() on the server. */
export function ideaMessages(ideas: boolean): Record<keyof typeof IDEA_MESSAGES, string> {
  return ideas ? IDEA_MESSAGES_AS_IDEAS : IDEA_MESSAGES;
}

/** An error code from the idea route, in words. */
export function ideaErrorText(code: unknown, ideas = false): string {
  const m = ideaMessages(ideas);
  if (code === "not_launched") return m.notLaunched;
  if (code === "product_not_found") return m.productGone;
  return m.notSaved;
}

/** "18 Nov", with the year when it isn't this one. */
export function ideaDay(iso: string | null | undefined, now: Date = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(d);
}

/** Who did something: "you", a team member's name, or Former team member. */
export function whoDid(userId: string | null | undefined, viewerId: string | null, names: Readonly<Record<string, string>>): string | null {
  if (!userId) return null;
  if (userId === viewerId) return "you";
  return Object.hasOwn(names, userId) ? names[userId]! : FORMER_TEAM_MEMBER;
}

/** "Set to Testing by you on 18 Nov." */
export function statusLine(idea: Idea, viewerId: string | null, names: Readonly<Record<string, string>>): string {
  if (!idea.status) return "No status yet.";
  const who = whoDid(idea.statusBy, viewerId, names);
  const when = ideaDay(idea.statusAt);
  return `Set to ${IDEA_STATUS_LABEL[idea.status]}${who ? ` by ${who}` : ""}${when ? ` on ${when}` : ""}.`;
}

/** "Handed off to Lumen app on 4 Nov by you.", or null before any hand-off. */
export function handedOffLine(
  idea: Idea,
  products: Readonly<Record<string, string>>,
  viewerId: string | null,
  names: Readonly<Record<string, string>>,
): string | null {
  if (!idea.productConnectionId) return null;
  const product = products[idea.productConnectionId] ?? "a product that isn't connected any more";
  const when = ideaDay(idea.handedOffAt);
  const who = whoDid(idea.handedOffBy, viewerId, names);
  return `Handed off to ${product}${when ? ` on ${when}` : ""}${who ? ` by ${who}` : ""}.`;
}
