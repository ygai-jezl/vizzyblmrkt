import { COMPETITOR_LIMITS, type ChangedSection } from "@/lib/types/competitor";
import { sectionOf } from "./shape";
import type { BaselinePage } from "./sitemap";

/**
 * What changed between two reads of a competitor's sitemap, grouped by section. Pure.
 *
 * The cautious rule: a page missing from a read that was not whole (a file failed, or either
 * read hit a cap) may simply not have been read, so such a read reports what it added and
 * nothing it "removed", and its new baseline keeps the old pages it didn't see. Only a whole
 * read against a whole baseline reports removals.
 */

/** Sections listed per side of a change. */
const MAX_SECTIONS = 15;

export interface SiteDiff {
  added: { count: number; sections: ChangedSection[] };
  removed: { count: number; sections: ChangedSection[] };
  /** Sections with pages now that had none before, and the reverse. */
  appeared: string[];
  gone: string[];
  /** The pages to keep as the next baseline. */
  next: BaselinePage[];
  /** Whether removals were counted (a whole read against a whole baseline). */
  whole: boolean;
}

function group(keys: string[]): ChangedSection[] {
  const by = new Map<string, string[]>();
  for (const k of keys) {
    const s = sectionOf(k);
    const list = by.get(s) ?? [];
    list.push(k);
    by.set(s, list);
  }
  return [...by]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SECTIONS)
    .map(([section, list]) => ({ section, count: list.length, sample: [...list].sort().slice(0, COMPETITOR_LIMITS.MAX_SAMPLE_PATHS) }));
}

function sectionsOf(pages: BaselinePage[]): Set<string> {
  return new Set(pages.map((p) => sectionOf(p.key)));
}

export function diffBaselines(before: BaselinePage[], after: BaselinePage[], opts: { whole: boolean }): SiteDiff {
  const old = new Map(before.map((p) => [p.key, p]));
  const now = new Map(after.map((p) => [p.key, p]));
  const added = after.filter((p) => !old.has(p.key)).map((p) => p.key);
  const removed = opts.whole ? before.filter((p) => !now.has(p.key)).map((p) => p.key) : [];
  const was = sectionsOf(before);
  const is = sectionsOf(after);
  const next = opts.whole
    ? after
    : [...after, ...before.filter((p) => !now.has(p.key))].slice(0, COMPETITOR_LIMITS.MAX_PAGES);
  return {
    added: { count: added.length, sections: group(added) },
    removed: { count: removed.length, sections: group(removed) },
    appeared: [...is].filter((s) => !was.has(s)).sort(),
    gone: opts.whole ? [...was].filter((s) => !is.has(s)).sort() : [],
    next,
    whole: opts.whole,
  };
}

/** Enough changed to read the site's shape again: 5% of its pages, or a section came or went. */
export function worthReanalysing(diff: SiteDiff, pages: number): boolean {
  const changed = diff.added.count + diff.removed.count;
  return diff.appeared.length > 0 || diff.gone.length > 0 || changed >= Math.max(1, Math.ceil(pages * 0.05));
}
