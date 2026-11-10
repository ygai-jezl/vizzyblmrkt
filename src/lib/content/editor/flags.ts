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

/**
 * Client and server flag — Vizzy inside Edit mode: select text and ask for a change, or ask
 * for edits across the piece. Changes are suggestions in the editor until Save. The server
 * route reads it at runtime too.
 */
export function isEditModeVizzyEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED === "true";
}

/**
 * Server flag — Vizzy learns each person's editing preferences (Agent Platform Memory Bank).
 * Needs the Vizzy switch, and VIZZY_MEMORY_BANK_ID before it does anything.
 */
export function isEditModeVizzyLearningEnabled(): boolean {
  return isEditModeVizzyEnabled() && process.env.EDIT_MODE_VIZZY_LEARNING_ENABLED === "true";
}
