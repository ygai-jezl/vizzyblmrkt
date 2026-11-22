import { LISTING_COPY, signInReasonWords } from "./words";

/**
 * What the Listing says after Sign in with Google sends people back (status and reason in the
 * address, never a code or token): the reason's own words when it didn't finish, or that it
 * connected. Null when nothing came back.
 */
export function listingBanner(q: { status: string | null; reason: string | null; reconnected: boolean }): { tone: "ok" | "err"; text: string } | null {
  if (q.status === "error") return { tone: "err", text: signInReasonWords(q.reason) };
  if (q.status === "connected") return { tone: "ok", text: q.reconnected ? LISTING_COPY.reconnectedBanner : LISTING_COPY.connectedBanner };
  return null;
}
