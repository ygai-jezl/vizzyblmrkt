/**
 * Flags for What we've seen (Brand › What we've seen): the brand's own first-hand notes,
 * which blog articles draw on when one matches their question strongly. Each is off unless
 * "true": listed "false" in apphosting.yaml and turned on per deployment. Off: nothing
 * reads or writes a note, and articles are written exactly as before.
 */

/** The notes, their page and APIs, and an article's matching. */
export function isBrandNotesEnabled(): boolean {
  return process.env.BRAND_NOTES_ENABLED === "true";
}

/** Client mirror (build-time): the tile on the Brand page and the article's "What we've seen" box. */
export function isBrandNotesUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_NOTES_ENABLED === "true";
}

/** Vizzy adds notes as suggestions (a person keeps them) and can interview a person for them. */
export function isBrandNotesChatEnabled(): boolean {
  return isBrandNotesEnabled() && process.env.BRAND_NOTES_CHAT_ENABLED === "true";
}
