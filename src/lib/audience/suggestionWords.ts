/**
 * What "Vizzy suggests" on a person's page says (AUDIENCE_VIZZY_FIELDS_ENABLED), word for word.
 * Pure, so the page, the route and the help page (your-audience, #vizzy) share it.
 */

export const SUGGESTION_NOTES = {
  waiting: "Also waiting in Review. Nothing changes until someone confirms.",
  members: "An admin can confirm or dismiss it.",
  confirmed: "Confirmed. You can undo it for 7 days.",
} as const;

/** The plain words for each answer the suggestions route gives. */
export const SUGGESTION_MESSAGES = {
  stale:
    "This suggestion was out of date, so it was set aside: a field changed since Vizzy made it, or Vizzy can no longer read one. Ask Vizzy again if it still fits, or set the value under Fields.",
  changed: "Someone else decided this suggestion. Reload the page to see what happened.",
  edited_since: "A field changed since this was confirmed, so it can't be undone here. Change it under Fields instead.",
  too_old: "This was confirmed more than 7 days ago, so it can't be undone here. Change it under Fields instead.",
  too_large: "This person's record can't hold any more. Shorten some long text in their fields first.",
  not_found: "This suggestion is no longer there. Reload the page.",
  forbidden: "Only admins can confirm, dismiss or undo Vizzy's suggestions.",
  failed: "That didn't save. Try again.",
} as const;

/** The plain words for an error the suggestions route answered. */
export function suggestionErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string };
  return (d.error && (SUGGESTION_MESSAGES as Record<string, string>)[d.error]) || SUGGESTION_MESSAGES.failed;
}
