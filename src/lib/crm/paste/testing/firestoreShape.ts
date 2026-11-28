/**
 * Firestore refuses a document that holds an array directly inside another array, and the
 * FakeFirestore doesn't check. The paste tests run every stored document through this, so a
 * multi select value can never again be saved as a column of arrays.
 */

/** The path of the first array held directly inside another array, or null when there is none. */
export function nestedArrayPath(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      if (Array.isArray(item)) return `${path}[${i}]`;
      const inner = nestedArrayPath(item, `${path}[${i}]`);
      if (inner) return inner;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const inner = nestedArrayPath(v, `${path}.${k}`);
      if (inner) return inner;
    }
  }
  return null;
}

/** Every document as stored is one Firestore would take: no array directly inside an array. */
export function firestoreSafe(docs: readonly unknown[]): string | null {
  for (const [i, d] of docs.entries()) {
    const at = nestedArrayPath(d, `doc${i}`);
    if (at) return at;
  }
  return null;
}
