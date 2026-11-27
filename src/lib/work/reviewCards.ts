import type { AgentActionId } from "@/lib/types/agentAction";
import type { WorkRead } from "./types";

/**
 * Work's three Review sections (ADR-0020, plan group 4), as the cards draw them:
 * - Checks due today (work_check): a measure's check asks did it work, with what Work counted and
 *   Better, Same, Worse and Too soon to tell; a date or task check has Done and Tomorrow. Both
 *   have Open.
 * - Ready to start (work_ready): Start moves the task to In progress, written as a change row
 *   with the tool review_ready, so the picks are kept for a later learner.
 * - Tasks Vizzy suggests (work_suggestion): Add to Work, Edit then add and Dismiss with a one tap
 *   reason.
 *
 * Pure: the payloads Review's items carry, the words on the cards and the lines after a tap.
 * Titles and Vizzy's words are shown as written, never as instructions.
 */

export type WorkReviewPayload =
  | {
      kind: "check";
      ref: number;
      /** A measure's check: it takes a read. */
      measure: boolean;
      /** When the check was set: a tap on it once it moved since (answered elsewhere, moved) is refused. */
      setAt: string;
    }
  | { kind: "ready"; ref: number; title: string }
  | {
      kind: "suggestion";
      actionId: AgentActionId;
      rev: number;
      title: string;
      stage: { n: number; label: string } | null;
      /** The brand it is for, shown only in a multi brand organisation. */
      brand: string | null;
      /** The ideas it names. */
      ideas: string[];
      /** "From today's log: Pricing research". */
      from: string;
      why: string;
      /**
       * How we'll know it worked as Vizzy would set it, and Vizzy's reason for the kind. `kindOnly`
       * when Vizzy names only a kind the person sets up on the task: the card says Vizzy suggests it.
       */
      measure: { text: string; why: string | null; kindOnly?: boolean } | null;
      editHref: string;
    };

export const WORK_REVIEW_COPY = {
  yourRead: "Your read:",
  didItWork: "Did it work?",
  done: "Done",
  tomorrow: "Tomorrow",
  open: "Open",
  start: "Start",
  addToWork: "Add to Work",
  editThenAdd: "Edit then add",
  dismiss: "Dismiss",
  whyDismiss: "Why dismiss it?",
  noReason: "No reason",
  cancel: "Cancel",
  openIt: "Open it",
  howWellKnow: "How we'll know:",
  vizzySuggestsKind: "Vizzy suggests:",
  kindOnlyHint: "Add it, then set how you'll know on the task.",
  saving: "Saving…",
  adding: "Adding…",
  dismissing: "Dismissing…",
  starting: "Starting…",
  nothingElse: "Nothing else is due on it.",
  offReview: "It's off Review until then.",
  wholeBusiness: "Whole business",
} as const;

/** The one tap read's labels, in the order drawn. */
export const READ_LABEL: Record<WorkRead, string> = {
  better: "Better",
  same: "Same",
  worse: "Worse",
  too_soon: "Too soon to tell",
};
export const READ_ORDER: readonly WorkRead[] = ["better", "same", "worse", "too_soon"];

/** What a tap on a check card did, for its done line. */
export type CheckTap = { action: "checked" } | { action: "look_again" } | { action: "read"; read: WorkRead };

/**
 * The line after a tap on a check card:
 * - Done: "#69 checked. It's off Review, and its history says you checked it today."
 * - Tomorrow: "#69: next check tomorrow at 08:00. It's off Review until then."
 * - Too soon to tell: "#57 checked: Too soon to tell. It asks again on 2 Dec at 08:00. It's off Review until then."
 * - Better, Same or Worse: "#57 checked: Same." and when the then's check is set, when it is;
 *   otherwise "Nothing else is due on it."
 * `notice` is the server's line about the check it set next, if any.
 */
export function checkDoneLine(ref: number, tap: CheckTap, notice: string | null): string {
  if (tap.action === "checked") return `#${ref} checked. It's off Review, and its history says you checked it today.`;
  if (tap.action === "look_again") return `#${ref}: next check tomorrow at 08:00. ${WORK_REVIEW_COPY.offReview}`;
  const label = READ_LABEL[tap.read];
  if (tap.read === "too_soon") return `#${ref} checked: ${label}.${notice ? ` ${notice}` : ""} ${WORK_REVIEW_COPY.offReview}`;
  return `#${ref} checked: ${label}. ${notice ?? WORK_REVIEW_COPY.nothingElse}`;
}

/** The line after Start: "Started #80 Import from other note apps. It's In progress, and Work keeps that you picked it." */
export function startedLine(ref: number, title: string): string {
  return `Started #${ref} ${title}. It's In progress, and Work keeps that you picked it.`;
}

/** A ready task's detail: "4 Build · Lumen for Teams · To do since 21 Nov. Nothing blocks it." */
export function readyDetail(parts: { stage: string | null; brand: string | null; since: string }): string {
  return [parts.stage, parts.brand, `To do since ${parts.since}. Nothing blocks it.`].filter(Boolean).join(" · ");
}

/** A due measure's check, as its card says it: "Did it work? Used: ... Work counted ..." */
export function measureCheckDetail(line: string): string {
  return `${WORK_REVIEW_COPY.didItWork} ${line}`.trim();
}
