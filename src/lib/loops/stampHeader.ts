/**
 * The header a save sends the stamp tokens of what it saves in (learning loops step 5, decision
 * 20): the tokens the output's route handed back beside it, comma separated. A header, so no save
 * route's body schema changes, and an old page that sends none saves exactly as before. Client
 * safe: no server code here.
 */
export const STAMP_HEADER = "x-stamp-tokens";

/** At most this many tokens are sent or read with one save. */
export const STAMP_HEADER_MAX = 20;

/** A save's headers with the tokens of what it saves, or none when there are none. */
export function stampHeaders(tokens: ReadonlyArray<string | null | undefined>): Record<string, string> {
  const kept = tokens.filter((t): t is string => typeof t === "string" && t.length > 0 && !t.includes(",")).slice(0, STAMP_HEADER_MAX);
  return kept.length ? { [STAMP_HEADER]: kept.join(",") } : {};
}

/** The tokens a save request sent, at most STAMP_HEADER_MAX. */
export function tokensFromRequest(req: Pick<Request, "headers">): string[] {
  const raw = req.headers.get(STAMP_HEADER) ?? "";
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, STAMP_HEADER_MAX);
}
