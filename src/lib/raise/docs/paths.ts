/**
 * Where the Raise kit lives in the admin. Plain strings with no imports, shared by server and
 * client code (the chat envelope reads the deck in view from the path).
 */

/** Content › Raise kit: the list of decks. */
export const RAISE_KIT_HREF = "/admin/raise";

/** One deck's studio, by its id. */
export function raiseDocHref(docId: string): string {
  return `${RAISE_KIT_HREF}/${encodeURIComponent(docId)}`;
}

/**
 * The deck in view on /admin/raise/{rd_id}, for Vizzy's deck tools: only a deck id, which the
 * chat's [ctx:{...}] envelope carries safely. Anything else (the list, another path) is none.
 */
export function raiseDocInView(pathname: string): string | null {
  const m = /^\/admin\/raise\/(rd_[a-z0-9]{12})(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}
