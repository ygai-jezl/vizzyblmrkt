import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import {
  BRAND_MAP_LIMITS as LIMITS,
  BrandMapDecidedSchema,
  BrandMapStoredSchema,
  BrandMapSuggestionSchema,
  brandMapDocId,
  isMapSaved,
  type BrandMap,
  type BrandMapChange,
  type BrandMapDecided,
  type BrandMapLink,
  type BrandMapResearch,
  type BrandMapSuggestion,
  type BrandMapSuggestionFrom,
} from "@/lib/types/brandMap";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { changeKey, isSatisfied, newId } from "./changes";
import { checkDecided, type MapIssue } from "./checks";
import { isBrandMapEnabled, isBrandMapScaleEnabled } from "./flags";

/**
 * The brand map's storage: one document per brand in the regional `brand_maps` collection.
 *
 *  - A person SAVES the decided half from the page, naming the revision they started from;
 *    a save over someone else's is refused with the current map (409 `map_changed`), the
 *    way the Connect catalog's is.
 *  - Research, articles and Vizzy FILE suggestions. Filing never touches the decided half
 *    and never moves `rev`, so it can never make a person's save fail.
 *  - A stored map that no longer parses is UNREADABLE, never absent: articles go on
 *    without it, and every write is refused until a person fixes it, so a write can never
 *    paper over a real map.
 */

export type BrandMapRead = { state: "none" } | { state: "unreadable" } | { state: "ok"; map: BrandMap };

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; issues?: MapIssue[]; current?: BrandMap };

class Unreadable extends Error {}
class TooLarge extends Error {}

const iso = (nowMs?: number) => new Date(nowMs ?? Date.now()).toISOString();
const sizeOf = (doc: unknown) => Buffer.byteLength(JSON.stringify(doc), "utf8");

/** A stored document as the app reads it. One suggestion that no longer parses is left out; the map still reads. */
export function parseBrandMap(raw: Record<string, unknown>): BrandMap | null {
  const stored = BrandMapStoredSchema.safeParse(raw);
  if (!stored.success) return null;
  const suggestions: BrandMapSuggestion[] = [];
  let dropped = 0;
  for (const row of stored.data.suggestions) {
    const s = BrandMapSuggestionSchema.safeParse(row);
    if (s.success) suggestions.push(s.data);
    else dropped += 1;
  }
  if (dropped) console.warn(`[brand-map] ${dropped} suggestion(s) could not be read and were left out`);
  return { ...stored.data, suggestions };
}

export async function readBrandMap(ctx: TenantContext, db?: FirestoreLike): Promise<BrandMapRead> {
  const raw = await forTenant(ctx, db).brandMaps.getById(brandMapDocId(ctx.tenantId));
  if (!raw) return { state: "none" };
  const map = parseBrandMap(raw);
  return map ? { state: "ok", map } : { state: "unreadable" };
}

/**
 * The map an article is written from: only with the flag on, only when it reads, and only
 * once a person has saved it (`rev` ≥ 1, or decided one of its records). Null otherwise —
 * and the article is written as before.
 */
export async function decidedBrandMap(ctx: TenantContext, db?: FirestoreLike): Promise<BrandMap | null> {
  if (!isBrandMapEnabled()) return null;
  const read = await readBrandMap(ctx, db).catch((): BrandMapRead => ({ state: "none" }));
  return read.state === "ok" && isMapSaved(read.map) ? read.map : null;
}

function decidedOf(map: BrandMapDecided): BrandMapDecided {
  return BrandMapDecidedSchema.parse({ identity: map.identity, subjects: map.subjects, names: map.names });
}

const sameDecided = (a: BrandMapDecided, b: BrandMapDecided) => JSON.stringify(decidedOf(a)) === JSON.stringify(decidedOf(b));

export function isEmptyDecided(d: BrandMapDecided): boolean {
  const i = d.identity;
  return (
    !i.name &&
    !i.category &&
    !i.statement &&
    !i.site &&
    !i.isNot.length &&
    !i.avoid.length &&
    !i.profiles.length &&
    !i.categorySameAs.length &&
    !d.subjects.length &&
    !d.names.length
  );
}

/**
 * The server says when a link was confirmed: a link already on that row keeps its date, a
 * new one gets now. Whatever date the browser sent is ignored.
 */
function stampLinks(prev: BrandMapDecided | null, next: BrandMapDecided, now: string): BrandMapDecided {
  const out = structuredClone(next);
  const stamp = (links: BrandMapLink[], before: BrandMapLink[] = []): BrandMapLink[] =>
    links.map((l) => {
      const was = before.find((b) => normalizeUrl(b.url) === normalizeUrl(l.url));
      return { ...l, confirmedAt: was?.confirmedAt || now };
    });
  out.identity.profiles = stamp(out.identity.profiles, prev?.identity.profiles);
  out.identity.categorySameAs = stamp(out.identity.categorySameAs, prev?.identity.categorySameAs);
  out.names = out.names.map((n) => ({ ...n, sameAs: stamp(n.sameAs, prev?.names.find((p) => p.id === n.id)?.sameAs) }));
  return out;
}

function emptyStored(tenantId: string, now: string) {
  return {
    ...BrandMapDecidedSchema.parse({}),
    id: brandMapDocId(tenantId),
    tenantId,
    rev: 0,
    suggestions: [] as BrandMapSuggestion[],
    dismissed: [] as string[],
    research: null as BrandMapResearch | null,
    decidedAt: null as string | null,
    decidedBy: null as string | null,
    createdAt: now,
    updatedAt: now,
    moved: null as BrandMap["moved"],
    recordsDecidedAt: null as string | null,
  };
}

/** A body, stripped of what the server owns. */
function storable(doc: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, tenantId: _t, ...rest } = doc;
  void _id;
  void _t;
  return rest;
}

export interface SaveInput {
  /** The revision the person started from (0 = an empty map). */
  baseRev: number;
  /** The decided half, as the page has it. */
  decided: unknown;
  /** Keys of the suggestions the person accepted (their change is in `decided`) and dismissed. */
  accepted?: string[];
  dismissed?: string[];
  /** The brand's own domains (its root domain, allowed origins, sending domains). */
  ownSites?: (string | null | undefined)[];
}

/**
 * Save what a person decided. Refused when the map changed since they opened it (409
 * `map_changed`, with the current map), when it does not read (409 `map_unreadable`),
 * when it fails a check (400 `invalid_map`, with the issues) or would be too big (413).
 * Accepted and dismissed suggestions leave the list, and so does any the save made true.
 *
 * With the map at any size on and its subjects moved into records (`moved`), a save keeps
 * the stored `subjects` exactly as they were, whatever it was sent: a build without the
 * switch still reads them, so turning the switch off shows the map as it was at the move.
 */
export async function saveBrandMap(
  ctx: TenantContext,
  input: SaveInput,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<MapResult<BrandMap>> {
  // With the switch on, a moved map's subjects are never taken from a save, so they aren't
  // read or checked from one either. Off, a save is exactly as before (and can change them).
  const scale = isBrandMapScaleEnabled();
  const before = scale ? await readBrandMap(ctx, deps.db).catch((): BrandMapRead => ({ state: "none" })) : null;
  const movedBefore = before?.state === "ok" && Boolean(before.map.moved);
  const sent = movedBefore && input.decided && typeof input.decided === "object" ? { ...(input.decided as Record<string, unknown>), subjects: [] } : input.decided;
  const parsed = BrandMapDecidedSchema.safeParse(sent);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "invalid_map",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const issues = checkDecided(parsed.data, { ownSites: input.ownSites ?? [] });
  if (issues.length) return { ok: false, status: 400, error: "invalid_map", issues };

  const now = iso(deps.nowMs);
  const by = ctx.email ?? ctx.userId ?? null;
  const accepted = input.accepted ?? [];
  const dismissed = (input.dismissed ?? []).slice(0, LIMITS.dismissed);
  const seen: { conflict: BrandMap | null } = { conflict: null };
  try {
    const { doc } = await forTenant(ctx, deps.db).brandMaps.upsert(
      brandMapDocId(ctx.tenantId),
      () => {
        const decided = stampLinks(null, parsed.data, now);
        const changed = !isEmptyDecided(decided);
        const fresh = {
          ...emptyStored(ctx.tenantId, now),
          ...decided,
          rev: changed ? 1 : 0,
          dismissed,
          decidedAt: changed ? now : null,
          decidedBy: changed ? by : null,
        };
        if (sizeOf(fresh) > LIMITS.bytes) throw new TooLarge();
        return storable(fresh);
      },
      (current) => {
        const map = parseBrandMap(current);
        if (!map) throw new Unreadable();
        if (map.rev !== input.baseRev) {
          seen.conflict = map;
          return null;
        }
        const decided = stampLinks(map, scale && map.moved ? { ...parsed.data, subjects: map.subjects } : parsed.data, now);
        const changed = !sameDecided(map, decided);
        const resolved = new Set([...accepted, ...dismissed]);
        const patch = {
          ...decided,
          rev: changed ? map.rev + 1 : map.rev,
          suggestions: map.suggestions.filter((s) => !resolved.has(s.key) && !isSatisfied(decided, s.change)),
          dismissed: [...new Set([...dismissed, ...map.dismissed])].slice(0, LIMITS.dismissed),
          decidedAt: changed ? now : map.decidedAt,
          decidedBy: changed ? by : map.decidedBy,
          updatedAt: now,
        };
        if (sizeOf({ ...map, ...patch }) > LIMITS.bytes) throw new TooLarge();
        return patch;
      },
    );
    if (seen.conflict) return { ok: false, status: 409, error: "map_changed", current: seen.conflict };
    const map = parseBrandMap(doc);
    return map ? { ok: true, value: map } : { ok: false, status: 409, error: "map_unreadable" };
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, status: 409, error: "map_unreadable" };
    if (err instanceof TooLarge) return { ok: false, status: 413, error: "map_too_large" };
    throw err;
  }
}

/** One suggestion to file. */
export interface SuggestionInput {
  change: BrandMapChange;
  reason?: string;
  evidence?: BrandMapSuggestion["evidence"];
  inferred?: boolean;
  ref?: BrandMapSuggestion["ref"];
}

export interface FileInput {
  from: BrandMapSuggestionFrom;
  items: SuggestionInput[];
  /** Research replaces its own earlier rows: each run is the latest word. */
  replaceOwn?: boolean;
  /** Someone asked for it outright (Vizzy, on a person's word): an earlier dismissal does not stop it. */
  allowDismissed?: boolean;
  /** Research records when it ran and what it could not do. */
  research?: BrandMapResearch | null;
  /** The map at any size: the buying situations the questions proposed here are asked in. */
  situationIds?: string[];
}

export interface Filed {
  filed: BrandMapSuggestion[];
  skipped: { inMap: number; waiting: number; dismissed: number };
}

/**
 * Merge new suggestions into a map's list (pure; the store runs it inside a transaction).
 * A change already true of the map, already waiting, or dismissed before is skipped. Each
 * source keeps at most its own number of rows: the oldest of that source go first.
 */
export function mergeSuggestions(
  map: Pick<BrandMap, "identity" | "subjects" | "names" | "suggestions" | "dismissed">,
  input: FileInput,
  now: string,
  ids: (p: "sg") => string = newId,
): { suggestions: BrandMapSuggestion[]; dismissed: string[]; result: Filed } {
  const decided = decidedOf(map);
  let suggestions = input.replaceOwn ? map.suggestions.filter((s) => s.from !== input.from) : [...map.suggestions];
  let dismissed = [...map.dismissed];
  const waiting = new Set(suggestions.map((s) => s.key));
  const result: Filed = { filed: [], skipped: { inMap: 0, waiting: 0, dismissed: 0 } };
  for (const item of input.items) {
    const key = changeKey(item.change);
    if (isSatisfied(decided, item.change)) {
      result.skipped.inMap += 1;
      continue;
    }
    if (waiting.has(key)) {
      result.skipped.waiting += 1;
      continue;
    }
    if (dismissed.includes(key)) {
      if (!input.allowDismissed) {
        result.skipped.dismissed += 1;
        continue;
      }
      dismissed = dismissed.filter((k) => k !== key);
    }
    const row = BrandMapSuggestionSchema.parse({
      id: ids("sg"),
      key,
      change: item.change,
      reason: (item.reason ?? "").slice(0, LIMITS.reason),
      from: input.from,
      ...(item.evidence ? { evidence: item.evidence } : {}),
      inferred: Boolean(item.inferred),
      ...(item.ref ? { ref: item.ref } : {}),
      at: now,
    });
    suggestions.push(row);
    waiting.add(key);
    result.filed.push(row);
  }
  const cap = LIMITS.suggestions[input.from];
  const mine = suggestions.filter((s) => s.from === input.from);
  if (mine.length > cap) {
    const drop = new Set(mine.slice(0, mine.length - cap).map((s) => s.id));
    suggestions = suggestions.filter((s) => !drop.has(s.id));
    result.filed = result.filed.filter((s) => !drop.has(s.id));
  }
  return { suggestions, dismissed, result };
}

/**
 * File suggestions for the brand map. Never changes what is decided and never moves `rev`.
 * The map is created empty if the brand has none yet. Refused only when the map does not
 * read (409 `map_unreadable`).
 */
export async function fileBrandMapSuggestions(
  ctx: TenantContext,
  input: FileInput,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<MapResult<Filed>> {
  const now = iso(deps.nowMs);
  const out: { result: Filed | null } = { result: null };
  /** Drop this source's oldest rows until the document fits. */
  const fit = (base: Record<string, unknown>, merged: ReturnType<typeof mergeSuggestions>) => {
    let suggestions = merged.suggestions;
    while (sizeOf({ ...base, suggestions }) > LIMITS.bytes) {
      const oldest = suggestions.find((s) => s.from === input.from);
      if (!oldest) throw new TooLarge();
      suggestions = suggestions.filter((s) => s !== oldest);
      merged.result.filed = merged.result.filed.filter((s) => s.id !== oldest.id);
    }
    return suggestions;
  };
  try {
    await forTenant(ctx, deps.db).brandMaps.upsert(
      brandMapDocId(ctx.tenantId),
      () => {
        const base = emptyStored(ctx.tenantId, now);
        const merged = mergeSuggestions(base, input, now);
        const suggestions = fit(base, merged);
        out.result = merged.result;
        return storable({
          ...base,
          suggestions,
          dismissed: merged.dismissed,
          ...(input.research !== undefined ? { research: input.research } : {}),
        });
      },
      (current) => {
        const map = parseBrandMap(current);
        if (!map) throw new Unreadable();
        const merged = mergeSuggestions(map, input, now);
        const suggestions = fit(map, merged);
        out.result = merged.result;
        return {
          suggestions,
          dismissed: merged.dismissed,
          ...(input.research !== undefined ? { research: input.research } : {}),
          updatedAt: now,
        };
      },
    );
    return { ok: true, value: out.result ?? { filed: [], skipped: { inMap: 0, waiting: 0, dismissed: 0 } } };
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, status: 409, error: "map_unreadable" };
    if (err instanceof TooLarge) return { ok: false, status: 413, error: "map_too_large" };
    throw err;
  }
}

/** Dismiss suggestions now (no Save needed): they leave the list and are never filed again. */
export async function dismissBrandMapSuggestions(
  ctx: TenantContext,
  keys: string[],
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<MapResult<BrandMap>> {
  const now = iso(deps.nowMs);
  const wanted = keys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 200).slice(0, LIMITS.dismissed);
  if (!wanted.length) return { ok: false, status: 400, error: "no_keys" };
  try {
    const saved = await forTenant(ctx, deps.db).brandMaps.claim(brandMapDocId(ctx.tenantId), (current) => {
      const map = parseBrandMap(current);
      if (!map) throw new Unreadable();
      const drop = new Set(wanted);
      return {
        suggestions: map.suggestions.filter((s) => !drop.has(s.key)),
        dismissed: [...new Set([...wanted, ...map.dismissed])].slice(0, LIMITS.dismissed),
        updatedAt: now,
      };
    });
    if (!saved) return { ok: false, status: 404, error: "no_brand_map" };
    const map = parseBrandMap(saved);
    return map ? { ok: true, value: map } : { ok: false, status: 409, error: "map_unreadable" };
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, status: 409, error: "map_unreadable" };
    throw err;
  }
}
