import { createHash } from "node:crypto";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { listAllTenants } from "@/lib/tenant/registry";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { embedForSearch } from "@/lib/agents/embeddings";
import { readBrandStubs, type BrandStubs, type StubsOptions } from "./feeders";
import { isSearchFamilyIndexEnabled, isSearchIndexEnabled } from "./flags";
import { estimateIndex, indexSource, storedSourceKey } from "./indexer";
import type { SearchKind, SearchManifest, SearchStore } from "./types";

/**
 * The scheduled check: compares what a brand has with what its index holds, indexes what is new
 * or changed (by version, so unchanged records cost nothing), and removes what is gone. It is
 * the main feeder, so a save that wasn't written through still reaches the index within minutes.
 * Removal only touches kinds that were read in full, so a failed read never empties the index.
 *
 * With SEARCH_FAMILY_INDEX_ENABLED (ADR-0025) every brand is checked, not only those granted
 * brand_search, and the brand map family (the map, notes and competitors) is read on the brand's
 * family turn, about every 6 hours: write-through keeps it current between turns. A brand without
 * brand_search is checked only on its turn, and only for the family.
 */

/** How long a record kept without vectors waits before the check tries to embed it again. */
export const RETRY_UNEMBEDDED_MS = 6 * 60 * 60 * 1000;

export interface SweepCounts {
  records: number;
  changed: number;
  indexed: number;
  unchanged: number;
  removed: number;
  failed: number;
  /** True when time ran out before every changed record was indexed (the next check carries on). */
  partial: boolean;
  /** The kinds whose read failed: nothing of them was indexed or removed (scripts/search-backfill.ts counts them as failures). */
  unread: SearchKind[];
  byKind: Partial<Record<SearchKind, number>>;
  /**
   * With `estimate` on a dry run: what --apply would embed (chunks, and the characters sent, about
   * 4 to a token) and how many records would only have their status rewritten.
   */
  estimate?: { chunks: number; chars: number; statusOnly: number };
}

export interface SweepDeps {
  store?: SearchStore;
  read?: (ctx: TenantContext, opts: StubsOptions) => Promise<BrandStubs>;
  embed?: typeof embedForSearch;
  clock?: () => number;
}

export async function sweepBrand(
  ctx: TenantContext,
  opts: { deadlineMs?: number; dryRun?: boolean; /** On a dry run, load what changed to count what --apply would embed. */ estimate?: boolean } & StubsOptions = {},
  deps: SweepDeps = {},
): Promise<SweepCounts> {
  const clock = deps.clock ?? Date.now;
  const store = deps.store ?? searchStoreFor(ctx);
  // A record written (through, or by another check) from now on is newer than what this check
  // reads, so it stands: indexing the stub read here would put back older text or status, which on
  // a family turn would stay until the next turn, 6 hours on.
  const readAt = clock();
  // Strictly after: a write in the same millisecond the read began is taken as before it.
  const writtenSince = (m: SearchManifest) => (Date.parse(m.indexedAt) || 0) > readAt;
  // On a family turn, what the index held before the read too: a record removed while the check
  // read (a note deleted or ticked as naming a customer, removed at once and forced) must not come
  // back from the older read for 6 hours. One more listing a turn, not a check.
  const familyRead = isSearchFamilyIndexEnabled() && opts.familyNow !== false && !opts.dryRun;
  const before = familyRead ? new Set((await store.listManifests()).map((m) => m.sourceKey)) : null;
  const { stubs, complete, failed: unread } = await (deps.read ?? readBrandStubs)(ctx, { familyOnly: opts.familyOnly, familyNow: opts.familyNow, kinds: opts.kinds });
  const manifests = new Map((await store.listManifests()).map((m) => [m.sourceKey, m]));
  const counts: SweepCounts = { records: stubs.length, changed: 0, indexed: 0, unchanged: 0, removed: 0, failed: 0, partial: false, unread: [...(unread ?? [])].sort(), byKind: {} };
  for (const st of stubs) counts.byKind[st.kind] = (counts.byKind[st.kind] ?? 0) + 1;

  // Keys under the name each kind is written as now: an entry stored under another name is gone,
  // so a renamed kind moves over in one check (and back, if its switch is turned off).
  const present = new Set(stubs.map((st) => storedSourceKey(st.kind, st.ref)));
  const gone = [...manifests.values()].filter((m) => !present.has(m.sourceKey) && complete.has(m.kind) && !writtenSince(m));
  const now = clock();
  const changed = stubs.filter((st) => {
    const m = manifests.get(storedSourceKey(st.kind, st.ref));
    if (!m || m.version !== st.version) return true;
    // Text kept without vectors (embedding failed or isn't set up): try again now and then, not every check.
    return !m.embedded && now - (Date.parse(m.indexedAt) || 0) >= RETRY_UNEMBEDDED_MS;
  });
  counts.changed = changed.length;
  if (opts.dryRun) {
    counts.removed = gone.length;
    if (opts.estimate) {
      const est = { chunks: 0, chars: 0, statusOnly: 0 };
      for (const st of changed) {
        const source = await st.load().catch(() => null);
        if (!source) continue;
        const e = estimateIndex(source, manifests.get(storedSourceKey(st.kind, st.ref)) ?? null);
        est.chunks += e.chunks;
        est.chars += e.chars;
        if (e.action === "status") est.statusOnly += 1;
      }
      counts.estimate = est;
    }
    return counts;
  }

  for (const m of gone) {
    try {
      await store.removeSource(m.sourceKey);
      counts.removed += 1;
    } catch {
      counts.failed += 1;
    }
  }
  for (const st of changed) {
    if (opts.deadlineMs !== undefined && clock() >= opts.deadlineMs) {
      counts.partial = true;
      break;
    }
    const key = storedSourceKey(st.kind, st.ref);
    // Its manifest again, just before writing: one written since this check began reading stands,
    // and one removed since it began (a removal is forced at once) stays removed.
    const listed = manifests.get(key) ?? null;
    const prev = await store.getManifest(key).catch(() => listed);
    const removedSince = !prev && (listed !== null || Boolean(before?.has(key)));
    if (removedSince || (prev && writtenSince(prev))) {
      counts.unchanged += 1;
      continue;
    }
    let source;
    try {
      source = await st.load();
    } catch {
      counts.failed += 1;
      continue;
    }
    if (!source) {
      if (prev) await store.removeSource(key).catch(() => undefined);
      counts.removed += prev ? 1 : 0;
      continue;
    }
    // A brand checked for the family only isn't granted the rest (the indexer lets the family through).
    const outcome = await indexSource(ctx, source, { store, granted: !opts.familyOnly, prev, version: st.version, embed: deps.embed });
    if (outcome === "indexed" || outcome === "indexed_without_vectors" || outcome === "removed") counts.indexed += 1;
    else if (outcome === "unchanged") counts.unchanged += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** The lifecycle tick runs every 2 minutes; every 5th one (about 10 minutes) checks the brands. */
const TICK_MS = 120_000;
const SWEEP_EVERY = 5;
/** Below this, no new brand is started. */
const MIN_LEFT_MS = 8_000;

export function isSweepTick(nowMs: number): boolean {
  return Math.floor(nowMs / TICK_MS) % SWEEP_EVERY === 0;
}

/** The family is read once every this many checks (about 6 hours at one check every 10 minutes). */
export const FAMILY_TURNS = 36;

/**
 * Whether this check is the brand's family turn: one check in FAMILY_TURNS, picked from the brand's
 * id, so brands' turns spread across the 6 hours.
 */
export function isFamilyTurn(tenantId: string, nowMs: number): boolean {
  const slot = parseInt(createHash("sha256").update(tenantId).digest("hex").slice(0, 8), 16) % FAMILY_TURNS;
  return Math.floor(nowMs / (TICK_MS * SWEEP_EVERY)) % FAMILY_TURNS === slot;
}

export interface SearchTickResult {
  swept: number;
  indexed: number;
  removed: number;
  failed: number;
  scanned: boolean;
}

/**
 * From the lifecycle tick (worker secret only): check each brand that may use search, taking turns.
 * With the family switch on, also each other brand on its family turn, for the family only. Brands
 * on their turn go first, since they get one turn in 6 hours; the rest take turns as before.
 */
export async function runSearchSweeps(
  opts: { deadlineMs: number },
  deps: SweepDeps & { listTenants?: () => Promise<Tenant[]> } = {},
): Promise<SearchTickResult> {
  const result: SearchTickResult = { swept: 0, indexed: 0, removed: 0, failed: 0, scanned: false };
  if (!isSearchIndexEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  if (!isSweepTick(clock())) return result;
  result.scanned = true;
  const family = isSearchFamilyIndexEnabled();
  const now = clock();
  const plans = (await (deps.listTenants ?? listAllTenants)()).flatMap((t) => {
    const granted = tenantMayUse(t, "brand_search");
    const turn = family && isFamilyTurn(t.id, now);
    // Without brand_search, only the family, only on its turn.
    if (!granted && !turn) return [];
    return [{ t, turn, familyOnly: !granted }];
  });
  const offset = plans.length ? Math.floor(now / (TICK_MS * SWEEP_EVERY)) % plans.length : 0;
  const rotated = [...plans.slice(offset), ...plans.slice(0, offset)];
  for (const { t, turn, familyOnly } of [...rotated.filter((p) => p.turn), ...rotated.filter((p) => !p.turn)]) {
    if (opts.deadlineMs - clock() < MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const c = await sweepBrand(ctx, { deadlineMs: opts.deadlineMs - MIN_LEFT_MS / 2, familyOnly, familyNow: turn }, deps);
      result.swept += 1;
      result.indexed += c.indexed;
      result.removed += c.removed;
      result.failed += c.failed;
    } catch (err) {
      result.failed += 1;
      console.warn(`[search] check failed for ${t.id} (${t.region}): ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  return result;
}
