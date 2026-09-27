/**
 * A journey's test list, as people type it: one list of the product's user ids
 * and email addresses. Pure and client-safe — the Delivery tab splits what's typed
 * and the enrolment rules match it.
 */

/** Whether a test-list entry is an email address rather than a user id. */
export function looksLikeEmail(entry: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.trim());
}

/** One typed list → the journey's `testRecipients`: anything with an @ is an address, the rest are user ids. */
export function splitTestUsers(entries: string[]): { userIds: string[]; emails: string[] } {
  const userIds: string[] = [];
  const emails: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    (looksLikeEmail(e) ? emails : userIds).push(e);
  }
  return { userIds, emails };
}
