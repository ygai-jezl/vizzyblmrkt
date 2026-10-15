import {
  BrandMapDecidedSchema,
  BrandMapNameKind,
  type BrandMap,
  type BrandMapDecided,
  type BrandMapName,
  type BrandMapNameKind as Kind,
  type BrandMapResearch,
  type BrandMapSuggestion,
} from "@/lib/types/brandMap";
import { applyChanges } from "@/lib/brandMap/changes";
import type { Coverage } from "@/lib/content/blog/coverage";

/**
 * The Brand map editor's pure helpers: what the page starts from, whether it has unsaved
 * changes, which issues belong to which field, and the first-run fill. Client-safe.
 */

/** What the server page hands the editor. */
export interface BrandMapPageProps {
  initial: BrandMapDecided;
  rev: number;
  suggestions: BrandMapSuggestion[];
  research: BrandMapResearch | null;
  /** The stored map no longer reads: shown as a blocking banner, nothing editable. */
  unreadable: boolean;
  /** Admins save; members only see. */
  canEdit: boolean;
  /** Research may run (its flag is on and the model is configured). */
  canResearch: boolean;
  /** Identifier lookups may run (their flag is on). */
  canLookup: boolean;
  /** Filled into a blank map when a person starts it by hand. */
  defaults: { name: string; site: string };
  /** What the brand's pages answer (BRAND_MAP_PAGES_ENABLED and a saved map); null = not shown. */
  coverage?: Coverage | null;
  /** The programmes an open question can be written in ("Write this next"); null = not offered. */
  programmes?: Array<{ id: string; name: string }> | null;
}

export interface MapIssue {
  path: string;
  message: string;
}

export function decidedOf(map: Pick<BrandMap, "identity" | "subjects" | "names"> | null): BrandMapDecided {
  return BrandMapDecidedSchema.parse(map ? { identity: map.identity, subjects: map.subjects, names: map.names } : {});
}

/** Compared with every link's confirmation date left out (the server stamps those). */
function canonical(d: BrandMapDecided): string {
  return JSON.stringify(d, (key, value) => (key === "confirmedAt" ? undefined : value));
}

export function isDirty(a: BrandMapDecided, b: BrandMapDecided): boolean {
  return canonical(a) !== canonical(b);
}

export function isBlank(d: BrandMapDecided): boolean {
  const i = d.identity;
  return !i.name && !i.category && !i.statement && !i.site && !i.isNot.length && !i.avoid.length && !i.profiles.length && !d.subjects.length && !d.names.length;
}

/** The messages for one field ("identity.name") or everything under it ("names.3"). */
export function issuesAt(issues: MapIssue[], path: string): string[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`)).map((i) => i.message);
}

/** Names in page order, grouped by what they are to the brand. */
export function groupNames(names: BrandMapName[]): Array<{ kind: Kind; rows: Array<{ name: BrandMapName; index: number }> }> {
  return BrandMapNameKind.options.map((kind) => ({
    kind,
    rows: names.map((name, index) => ({ name, index })).filter((r) => r.name.kind === kind),
  }));
}

/**
 * The first time research fills an empty map: every suggestion that rests on something
 * stated is applied to the form at once, so a person reviews one draft and saves once. The
 * inferred ones (what the brand is not, names to avoid) wait, unticked, to be checked.
 */
export function firstRunFill(
  d: BrandMapDecided,
  suggestions: BrandMapSuggestion[],
): { decided: BrandMapDecided; accepted: string[]; waiting: BrandMapSuggestion[] } {
  const take = suggestions.filter((s) => s.from === "research" && !s.inferred);
  const { decided } = applyChanges(d, take.map((s) => s.change));
  return { decided, accepted: take.map((s) => s.key), waiting: suggestions.filter((s) => !take.includes(s)) };
}

/** Words of a list typed as "one, two, three". */
export function splitList(text: string, max: number): string[] {
  return [...new Set(text.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, max);
}
