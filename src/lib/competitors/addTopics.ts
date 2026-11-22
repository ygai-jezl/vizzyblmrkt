/**
 * What "Add to my map" did, for What they write about and Next up (client safe, no server code).
 */

/** Added to the map (a moved map), or filed as suggestions (a small map). */
export type AddTopicsResult = { mode: "added"; added: string[]; already: string[] } | { mode: "suggested"; filed: number; already: string[] };

const subjects = (n: number) => `${n} subject${n === 1 ? "" : "s"}`;

/** What the button did, in a sentence. */
export function addedNote(r: AddTopicsResult): string {
  const already = r.already.length ? ` Already on your map: ${r.already.join(", ")}.` : "";
  if (r.mode === "added") {
    if (!r.added.length) return already.trim() || "Nothing to add: those aren't on this page any more.";
    return `Added ${subjects(r.added.length)} to your brand map.${already}`;
  }
  if (r.filed) return `Suggested ${subjects(r.filed)} for your brand map. Decide on ${r.filed === 1 ? "it" : "them"} in Brand › Brand map.${already}`;
  return already.trim() || "Those are already suggested for your map.";
}
