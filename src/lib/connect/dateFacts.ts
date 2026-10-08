import type { CatalogFact } from "@/lib/types/productConnection";

/**
 * Date facts (CONNECT_DATE_FACTS): a fact whose value is a moment — when someone
 * was last active, when a trial ends. The product sends it as text and the
 * catalog marks the fact `date`. Journeys never compare the text: they read it as
 * whole days from now, worked out at the moment they check, so a value doesn't go
 * stale between the product's writes.
 *
 * Pure and client-safe (the journey editor's preview uses the same rules).
 */

const DAY_MS = 86_400_000;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** What a date fact's value must look like, for error messages and docs. */
export const DATE_FACT_FORMAT = "ISO 8601 with a timezone (2026-10-08T09:12:00Z) or a day (2026-10-08)";

/** Whether a value is a plain day (`YYYY-MM-DD`), which reads as midnight UTC and prints without a time zone shift. */
export function isDayOnly(value: unknown): boolean {
  return typeof value === "string" && DAY_ONLY.test(value.trim());
}

/** A date fact's value as epoch milliseconds; null when it isn't a date we accept (a local time has no zone, so it's refused). */
export function parseFactDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const day = DAY_ONLY.test(v);
  if (!day && !ZONED.test(v)) return null;
  const ms = Date.parse(day ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) return null;
  // `2026-02-31` parses (as 3 March): refuse a day that isn't on the calendar.
  if (day && new Date(ms).toISOString().slice(0, 10) !== v) return null;
  return ms;
}

/** Whole days since the date: 0 on the day itself, negative while it's still ahead. */
export function daysSince(dateMs: number, nowMs: number): number {
  return Math.floor((nowMs - dateMs) / DAY_MS) || 0;
}

/** Whole days until the date, rounded up: 3 means "within three days"; 0 or less once it has passed. */
export function daysUntil(dateMs: number, nowMs: number): number {
  return Math.ceil((dateMs - nowMs) / DAY_MS) || 0;
}

/** The ids of a catalog's date facts. */
export function dateFactIds(catalog: { facts?: ReadonlyArray<Pick<CatalogFact, "id" | "type">> } | null | undefined): Set<string> {
  return new Set((catalog?.facts ?? []).filter((f) => f.type === "date").map((f) => f.id));
}

/**
 * A date for an email or the admin: a long date in the reader's language. A zoned
 * value is shown in their time zone; a plain day is shown as that day everywhere.
 */
export function formatFactDate(value: unknown, locale?: string | null, timeZone?: string | null): string | null {
  const ms = parseFactDate(value);
  if (ms === null) return null;
  const zone = isDayOnly(value) ? "UTC" : timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat(locale || "en-GB", { dateStyle: "long", timeZone: zone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(ms);
  }
}

type FactsPatch = Record<string, unknown>;
interface PatchWithFacts {
  facts?: FactsPatch;
  entities?: Record<string, { facts?: FactsPatch } | null>;
}

/**
 * Take out of a write the date facts whose value isn't a date, so the rest of the
 * write applies and the value we hold stays as it was. Returns the paths taken
 * out (`facts.last_active_at`, `entities.b_1.facts.last_audit_at`). `null`
 * (remove the fact) is always fine.
 */
export function dropBadDateFacts<P extends PatchWithFacts>(patch: P, dateIds: ReadonlySet<string>): { patch: P; dropped: string[] } {
  if (dateIds.size === 0) return { patch, dropped: [] };
  const dropped: string[] = [];
  const clean = (facts: FactsPatch | undefined, prefix: string): FactsPatch | undefined => {
    if (!facts) return facts;
    const bad = Object.entries(facts).filter(([id, v]) => dateIds.has(id) && v !== null && parseFactDate(v) === null);
    if (bad.length === 0) return facts;
    for (const [id] of bad) dropped.push(`${prefix}${id}`);
    const gone = new Set(bad.map(([id]) => id));
    return Object.fromEntries(Object.entries(facts).filter(([id]) => !gone.has(id)));
  };
  const facts = clean(patch.facts, "facts.");
  let entities = patch.entities;
  if (entities) {
    const next: NonNullable<PatchWithFacts["entities"]> = {};
    for (const [id, e] of Object.entries(entities)) next[id] = e ? { ...e, ...(e.facts ? { facts: clean(e.facts, `entities.${id}.facts.`) } : {}) } : e;
    entities = next;
  }
  if (dropped.length === 0) return { patch, dropped };
  return { patch: { ...patch, ...(patch.facts ? { facts } : {}), ...(patch.entities ? { entities } : {}) }, dropped };
}
