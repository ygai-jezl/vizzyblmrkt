/** Where the person view lives in the admin. Plain strings, shared by server and client code. */

/** Audience, on its Product users tab. */
export const PEOPLE_HREF = "/admin/crm?tab=product";

/** One product user's page, by our id for them (never their name or address). */
export function personHref(personId: string): string {
  return `/admin/crm/people/${encodeURIComponent(personId)}`;
}

/** Our id of the person in view on /admin/crm/people/{id}, when it's one the chat's context can carry. */
export function personInView(pathname: string): string | null {
  const m = /^\/admin\/crm\/people\/([A-Za-z0-9_-]{1,128})(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}
