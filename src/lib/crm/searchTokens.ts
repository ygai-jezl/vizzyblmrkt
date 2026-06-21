/**
 * Build lowercased search tokens for Firestore `array-contains` matching —
 * the pragmatic stand-in for full-text search (which Firestore lacks). The
 * search routes tokenise the query the same way and match a single token, then
 * refine client-side over the page.
 *
 * SECURITY (§H6): tokens come ONLY from an alphanumeric allowlist (split on
 * anything else), are length-capped, and the set is count-capped — so an
 * attacker-controlled name/answer can't bloat the document or smuggle markup
 * into an index. Inputs are the contact/company's OWN fields (same regional DB),
 * never PII derived from a cross-region enrichment call.
 */
const MAX_TOKENS = 40;
const MAX_TOKEN_LEN = 40;

export function buildSearchTokens(parts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of parts) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    // The whole normalised value (e.g. full email / domain) as one token…
    const whole = lower.replace(/[^a-z0-9.@-]+/g, "");
    if (whole) out.add(whole.slice(0, MAX_TOKEN_LEN));
    // …plus each alphanumeric word fragment.
    for (const word of lower.split(/[^a-z0-9]+/)) {
      if (word) out.add(word.slice(0, MAX_TOKEN_LEN));
      if (out.size >= MAX_TOKENS) break;
    }
    if (out.size >= MAX_TOKENS) break;
  }
  return Array.from(out).slice(0, MAX_TOKENS);
}

/** Normalise a free-text search query into the single token we match on. */
export function queryToken(q: string): string {
  return q.trim().toLowerCase().replace(/[^a-z0-9.@-]+/g, "").slice(0, MAX_TOKEN_LEN);
}
