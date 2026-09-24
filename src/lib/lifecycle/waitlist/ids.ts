import { createHash } from "node:crypto";

/**
 * Ids for waitlist journeys on the lifecycle engine: one journey per launch,
 * and one enrolment per person per journey, so a person enters at most once.
 * Dependency-free, so the tenant layer (launch deletion) can use it.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/** The launch's waitlist journey (deterministic, so every caller finds the same one). */
export function waitlistJourneyId(campaignId: string): string {
  return `lcjw_${sha(campaignId)}`;
}

/** The same shape as a product enrolment's id (enrolmentDocId). */
export function waitlistEnrolmentId(journeyId: string, signupId: string): string {
  return `enr_${sha(`${journeyId}\n${signupId}`)}`;
}

/** A shadow rehearsal's enrolment: never the same document as a real one. */
export function rehearsalEnrolmentId(journeyId: string, signupId: string): string {
  return waitlistEnrolmentId(journeyId, `rehearsal\n${signupId}`);
}
