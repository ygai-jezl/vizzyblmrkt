import type { ConnectionCatalog } from "@/lib/types/productConnection";

/**
 * What changed between two versions of a connection's catalog, in plain words,
 * and carrying one person's edits over onto a newer catalog. Pure: the Catalog
 * tab uses it for unsaved edits and "reload and keep my changes", the catalog
 * history to describe each version.
 */

type ListKey = "entityKinds" | "onboardingSteps" | "events" | "traits" | "facts" | "glossary";
type Entry = Record<string, unknown>;

interface ListSpec {
  list: ListKey;
  noun: string;
  /** The entry's identity within its list (what Learn from repo matches on too). */
  key: (e: Entry) => string;
  /** How a person knows it. */
  name: (e: Entry) => string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const LISTS: ListSpec[] = [
  { list: "entityKinds", noun: "kind", key: (e) => str(e.kind), name: (e) => str(e.label) || str(e.kind) },
  { list: "onboardingSteps", noun: "step", key: (e) => str(e.id), name: (e) => str(e.label) || str(e.id) },
  { list: "events", noun: "event", key: (e) => str(e.name), name: (e) => str(e.name) },
  { list: "traits", noun: "trait", key: (e) => str(e.key), name: (e) => str(e.key) },
  { list: "facts", noun: "fact", key: (e) => str(e.id), name: (e) => str(e.label) || str(e.id) },
  { list: "glossary", noun: "term", key: (e) => str(e.term).trim().toLowerCase(), name: (e) => str(e.term) },
];

/** Steps in their display order; lists saved before facts or kinds existed are empty. */
function listOf(c: ConnectionCatalog, list: ListKey): Entry[] {
  const items = (c[list] ?? []) as Entry[];
  return list === "onboardingSteps" ? [...items].sort((a, b) => Number(a.order) - Number(b.order)) : items;
}

/** Same content: blank, null and missing fields are alike, and a step's position is compared separately. */
function same(a: Entry, b: Entry): boolean {
  const norm = (e: Entry) =>
    JSON.stringify(
      Object.keys(e)
        .filter((k) => k !== "order" && e[k] !== undefined && e[k] !== null && e[k] !== "")
        .sort()
        .map((k) => [k, e[k]]),
    );
  return norm(a) === norm(b);
}

function byKey(items: Entry[], spec: ListSpec): Map<string, Entry> {
  const m = new Map<string, Entry>();
  for (const e of items) {
    const k = spec.key(e);
    if (k && !m.has(k)) m.set(k, e);
  }
  return m;
}

const quote = (s: string) => `‘${s || "unnamed"}’`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Added step ‘Invite your team’", "Renamed fact ‘SoV’ to ‘Share of voice’"… — empty when nothing changed. */
export function describeChanges(before: ConnectionCatalog, after: ConnectionCatalog): string[] {
  const out: string[] = [];
  for (const spec of LISTS) {
    const b = listOf(before, spec.list);
    const a = listOf(after, spec.list);
    const bBy = byKey(b, spec);
    const aBy = byKey(a, spec);
    const seen = new Set<string>();
    for (const e of a) {
      const k = spec.key(e);
      const prev = k && !seen.has(k) ? bBy.get(k) : undefined;
      if (k) seen.add(k);
      if (!prev) out.push(`Added ${spec.noun} ${quote(spec.name(e))}`);
      else if (!same(prev, e)) {
        out.push(
          spec.name(prev) !== spec.name(e)
            ? `Renamed ${spec.noun} ${quote(spec.name(prev))} to ${quote(spec.name(e))}`
            : `Changed ${spec.noun} ${quote(spec.name(e))}`,
        );
      }
    }
    for (const e of b) if (!aBy.has(spec.key(e))) out.push(`Removed ${spec.noun} ${quote(spec.name(e))}`);
    if (spec.list === "onboardingSteps") {
      const kept = (list: Entry[], other: Map<string, Entry>) => list.map(spec.key).filter((k) => other.has(k));
      if (kept(b, aBy).join("\n") !== kept(a, bBy).join("\n")) out.push("Reordered steps");
    }
  }
  return out;
}

export function sameCatalog(a: ConnectionCatalog, b: ConnectionCatalog): boolean {
  return describeChanges(a, b).length === 0;
}

/**
 * Carry the edits made to `base` (giving `mine`) over onto `latest`, a newer
 * catalog saved elsewhere meanwhile. Entries are matched by id: yours win where
 * you changed one, theirs stay where you didn't, and every clash is noted so the
 * person can check before saving.
 */
export function rebaseCatalog(
  base: ConnectionCatalog,
  mine: ConnectionCatalog,
  latest: ConnectionCatalog,
): { catalog: ConnectionCatalog; notes: string[] } {
  const out: Record<string, unknown> = { ...latest };
  const notes: string[] = [];
  for (const spec of LISTS) {
    const bBy = byKey(listOf(base, spec.list), spec);
    const m = listOf(mine, spec.list);
    const mBy = byKey(m, spec);
    const t = listOf(latest, spec.list);
    const tBy = byKey(t, spec);
    const result: Entry[] = [];
    for (const e of t) {
      const k = spec.key(e);
      const was = bBy.get(k);
      const now = mBy.get(k);
      if (was && !now) {
        // You removed it: gone, unless it was changed elsewhere meanwhile.
        if (same(e, was)) continue;
        result.push(e);
        notes.push(`${cap(spec.noun)} ${quote(spec.name(e))} was changed elsewhere, so it wasn't removed`);
      } else if (now && !same(now, was ?? e)) {
        // You changed (or added) it: yours.
        if (was && !same(e, was)) notes.push(`${cap(spec.noun)} ${quote(spec.name(now))} was also changed elsewhere — yours is kept`);
        if (!was) notes.push(`${cap(spec.noun)} ${quote(spec.name(now))} was also added elsewhere — yours is kept`);
        result.push(now);
      } else {
        result.push(e);
      }
    }
    const seen = new Set<string>();
    for (const e of m) {
      const k = spec.key(e);
      const repeat = Boolean(k) && seen.has(k);
      if (k) seen.add(k);
      if (!repeat && k && tBy.has(k)) continue; // settled above
      const was = !repeat && k ? bBy.get(k) : undefined;
      if (!was) {
        result.push(e); // yours, new
      } else if (!same(e, was)) {
        result.push(e);
        notes.push(`${cap(spec.noun)} ${quote(spec.name(e))} was removed elsewhere — kept because you changed it`);
      }
    }
    out[spec.list] = spec.list === "onboardingSteps" ? result.map((s, i) => ({ ...s, order: i })) : result;
  }
  return { catalog: out as ConnectionCatalog, notes };
}
