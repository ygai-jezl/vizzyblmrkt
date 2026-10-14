/**
 * An article's address: where it lives, or will (BRAND_MAP_PAGES_ENABLED). It is the plan's
 * hub URL, set on the canvas after the plan was made: the page the live check opens, the
 * markup's @id, and the address the brand map shows for the questions it answers.
 * Pure + client-safe.
 */

export type AddressProblem = "not_https" | "home_page";

export const ADDRESS_PROBLEM: Record<AddressProblem, string> = {
  not_https: "Use the article's full address, starting with https://",
  home_page: "That's a home page. Use the address of the article itself.",
};

/** How saving an address went. */
export type AddressSaved = "saved" | AddressProblem | "failed";

export const isAddressProblem = (s: unknown): s is AddressProblem => s === "not_https" || s === "home_page";

/** Why this cannot be an article's address, or null when it can. */
export function articleAddressProblem(url: string): AddressProblem | null {
  const u = url.trim();
  if (u.length > 2000 || !/^https:\/\/[^\s<>"'`]+$/i.test(u)) return "not_https";
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "not_https";
  }
  if (!parsed.hostname) return "not_https";
  // A bare home page (give or take a #fragment) is never one article. "/?p=12" can be.
  if (parsed.pathname === "/" && !parsed.search) return "home_page";
  return null;
}
