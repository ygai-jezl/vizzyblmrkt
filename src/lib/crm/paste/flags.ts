import { canAddPeople, isAddPersonEnabled, isVizzyAddPersonEnabled } from "@/lib/audience/peopleFlags";

/**
 * Paste a list on People (RAISE_PASTE_ENABLED, needs New person): an admin pastes rows from a
 * sheet, the app's own code reads them (no AI, nothing paid), and one Review card adds up to 50
 * people and companies, each with where the list is from. Server only, off unless "true": listed
 * "false" in apphosting.yaml and turned on per deployment.
 *
 * Off: no button, no sheet, the admin routes don't exist (404), the agent route is unavailable
 * (503), Review shows no pasted lists and Remove company is hidden. People and companies already
 * added stay, and open lists expire with the tick's sweep as usual.
 */
export function isPasteEnabled(): boolean {
  return isAddPersonEnabled() && process.env.RAISE_PASTE_ENABLED === "true";
}

/**
 * Pasting a list into Ask Vizzy: needs Vizzy's New person drafts too
 * (AUDIENCE_VIZZY_ADD_PERSON_ENABLED), since what is pasted into the chat stays in its history.
 */
export function isVizzyPasteEnabled(): boolean {
  return isPasteEnabled() && isVizzyAddPersonEnabled();
}

/** Whether someone with this role can paste a list here: an admin, with People on screen (canAddPeople). */
export function canPaste(role: string | null | undefined): boolean {
  return isPasteEnabled() && canAddPeople(role);
}
