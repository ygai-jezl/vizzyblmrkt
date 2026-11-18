import { tenantMayUse } from "@/lib/plans/brandAccess";
import { listAllTenants } from "@/lib/tenant/registry";
import { searchStoreFor } from "@/lib/tenant/searchIndex";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { embedForSearch } from "@/lib/agents/embeddings";
import { readBrandStubs, type BrandStubs } from "./feeders";
import { isSearchIndexEnabled } from "./flags";
import { indexSource } from "./indexer";
import type { SearchKind, SearchStore } from "./types";
import { sourceKeyOf } from "./types";

/**
 * The scheduled check: compares what a brand has with what its index holds, indexes what is new
 * or changed (by version, so unchanged records cost nothing), and removes what is gone. It is
 * the main feeder, so a save that wasn't written through still reaches the index within minutes.
 * Removal only touches kinds that were read in full, so a failed read never empties the index.
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
  byKind: Partial<Record<SearchKind, number>>;
}

export interface SweepDeps {
  store?: SearchStore;
  read?: (ctx: TenantContext) => Promise<BrandStubs>;
  embed?: typeof embedForSearch;
  clock?: () => number;
}

export async function sweepBrand(
  ctx: TenantContext,
  opts: { deadlineMs?: number; dryRun?: boolean } = {},
  deps: SweepDeps = {},
): Promise<SweepCounts> {
  const clock = deps.clock ?? Date.now;
  const store = deps.store ?? searchStoreFor(ctx);
  const { stubs, complete } = await (deps.read ?? readBrandStubs)(ctx);
  const manifests = new Map((await store.listManifests()).map((m) => [m.sourceKey, m]));
  const counts: SweepCounts = { records: stubs.length, changed: 0, indexed: 0, unchanged: 0, removed: 0, failed: 0, partial: false, byKind: {} };
  for (const st of stubs) counts.byKind[st.kind] = (counts.byKind[st.kind] ?? 0) + 1;

  const present = new Set(stubs.map((st) => sourceKeyOf(st.kind, st.ref)));
  const gone = [...manifests.values()].filter((m) => !present.has(m.sourceKey) && complete.has(m.kind));
  const now = clock();
  const changed = stubs.filter((st) => {
    const m = manifests.get(sourceKeyOf(st.kind, st.ref));
    if (!m || m.version !== st.version) return true;
    // Text kept without vectors (embedding failed or isn't set up): try again now and then, not every check.
    return !m.embedded && now - (Date.parse(m.indexedAt) || 0) >= RETRY_UNEMBEDDED_MS;
  });
  counts.changed = changed.length;
  if (opts.dryRun) {
    counts.removed = gone.length;
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
    const key = sourceKeyOf(st.kind, st.ref);
    const prev = manifests.get(key) ?? null;
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
    const outcome = await indexSource(ctx, source, { store, granted: true, prev, version: st.version, embed: deps.embed });
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

export interface SearchTickResult {
  swept: number;
  indexed: number;
  removed: number;
  failed: number;
  scanned: boolean;
}

/** From the lifecycle tick (worker secret only): check each brand that may use search, taking turns. */
export async function runSearchSweeps(
  opts: { deadlineMs: number },
  deps: SweepDeps & { listTenants?: () => Promise<Tenant[]> } = {},
): Promise<SearchTickResult> {
  const result: SearchTickResult = { swept: 0, indexed: 0, removed: 0, failed: 0, scanned: false };
  if (!isSearchIndexEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  if (!isSweepTick(clock())) return result;
  result.scanned = true;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => tenantMayUse(t, "brand_search"));
  const offset = tenants.length ? Math.floor(clock() / (TICK_MS * SWEEP_EVERY)) % tenants.length : 0;
  for (const t of [...tenants.slice(offset), ...tenants.slice(0, offset)]) {
    if (opts.deadlineMs - clock() < MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const c = await sweepBrand(ctx, { deadlineMs: opts.deadlineMs - MIN_LEFT_MS / 2 }, deps);
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
