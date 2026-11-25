import { isNavIdeasEnabled } from "@/lib/nav/flags";

/**
 * Ideas (piece D): a launch is an idea being tested, with a hypothesis, a status (who set it and
 * when), an outcome and a hand-off to the product it became; ideas side by side; and People's
 * "in more than one launch". Off = launches behave exactly as before: no card, no badge, no
 * compare, and the idea route answers 404. Server only: pages and routes read it and pass the
 * answer down.
 */
export function isIdeasEnabled(): boolean {
  return process.env.LAUNCH_IDEAS_ENABLED === "true";
}

/**
 * The screens say Idea where they said Launch: nav v2 phase 3, NEXT_PUBLIC_NAV_IDEAS_ENABLED and
 * LAUNCH_IDEAS_ENABLED all on. Ideas on with the words off is a valid setting: the features work
 * and still say Launch. Worked out on the server (half of it is a server switch): the admin layout
 * passes the answer to the shell and to WordsProvider, and server pages call it themselves.
 */
export function isIdeaWordsEnabled(): boolean {
  return isNavIdeasEnabled() && isIdeasEnabled();
}
