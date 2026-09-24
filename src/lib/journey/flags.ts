/**
 * Waitlist journey flags (engine move D1).
 *
 * WAITLIST_JOURNEY_HOLD_ON_PAUSE: a paused or draft journey, or an archived
 * launch, HOLDS each person's next step instead of ending their sequence, and
 * new signups join a paused journey and wait. Off = the original behaviour
 * (the step is marked done and the person gets nothing more).
 */
export function isHoldOnPauseEnabled(): boolean {
  return process.env.WAITLIST_JOURNEY_HOLD_ON_PAUSE === "true";
}
