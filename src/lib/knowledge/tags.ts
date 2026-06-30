/** Custom-tag normalization for knowledge sources: trim, lowercase, collapse
 *  whitespace, dedupe, and cap count/length. Keeps tags clean + queryable
 *  (array-contains pre-filter on `tags`). */
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
