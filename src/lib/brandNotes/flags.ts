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

/**
 * An article's questions for its team are kept on What we've seen as open questions, linked to
 * the article, each answered in its own box that saves as it is typed; another article reuses an
 * open question that fits it (needs the notes).
 */
export function isBrandNotesQuestionsEnabled(): boolean {
  return isBrandNotesEnabled() && process.env.BRAND_NOTES_QUESTIONS_ENABLED === "true";
}

/** Client mirror (build-time), for the help pages only: screens get the server value as a prop. */
export function isBrandNotesQuestionsUiEnabled(): boolean {
  return isBrandNotesUiEnabled() && process.env.NEXT_PUBLIC_BRAND_NOTES_QUESTIONS_ENABLED === "true";
}

/**
 * A note rests after an article uses it, and goes in only by hand once enough articles have; every
 * article asks its team three new questions whatever matched (needs the open questions).
 */
export function isBrandNotesRestEnabled(): boolean {
  return isBrandNotesQuestionsEnabled() && process.env.BRAND_NOTES_REST_ENABLED === "true";
}

/** Client mirror (build-time), for the help pages only: screens get the server value as a prop. */
export function isBrandNotesRestUiEnabled(): boolean {
  return isBrandNotesQuestionsUiEnabled() && process.env.NEXT_PUBLIC_BRAND_NOTES_REST_ENABLED === "true";
}
