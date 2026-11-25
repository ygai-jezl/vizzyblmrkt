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
