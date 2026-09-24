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

/**
 * Engine move D6: retiring the original waitlist journey editor, in two stages,
 * once every launch has moved to the lifecycle engine, drained, and 30 days
 * have passed (WAITLIST_LEGACY_EDITOR):
 *
 *   read_only  the original editor is read-only: saving, a first publish and
 *              Vizzy's drafts there are refused, pointing to the new editor.
 *              Pausing and resuming still work.
 *   retired    the same, and its page sends people to the new editor (or to
 *              the launch's Settings to move it).
 *
 * Unset = today. Whatever this says, the original engine keeps sending what's
 * already queued, and its unsubscribe links keep working.
 */
export function legacyEditorMode(): "edit" | "read_only" | "retired" {
  const v = process.env.WAITLIST_LEGACY_EDITOR;
  return v === "read_only" || v === "retired" ? v : "edit";
}
