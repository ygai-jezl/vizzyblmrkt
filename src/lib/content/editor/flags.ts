/**
 * Edit mode switches: a rich text editor opened from the raw text of long content. Pure +
 * client-safe. Each is off unless "true" (listed "false" in apphosting.yaml, turned on per
 * deployment). Off: the raw text boxes exactly as before.
 */

/** Client flag — Edit mode on blog and newsletter hubs. What is saved is still Markdown. */
export function isEditModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EDIT_MODE_ENABLED === "true";
}

/** Client flag — Edit mode on broadcast, journey and lifecycle emails (saved as sanitized HTML). */
export function isEditModeEmailsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EDIT_MODE_EMAILS_ENABLED === "true";
}
