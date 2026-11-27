import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { ResourceCount } from "@/lib/types/usageMeter";
import type { AiUsage } from "@/lib/agents/gemini";
import { DEFAULT_LOCALE, normalizeLocale } from "@/lib/i18n/locale";
import { isUsageMeterEnabled } from "./flags";
import { isLimitedResource, monthlyLimitOf } from "./limits";
import type { ResourceId, ResourcePurpose } from "./resources";

/**
 * The usage meter (USAGE_METER_ENABLED): what a brand used of each paid resource
 * (src/lib/plans/resources.ts) this calendar month, by the feature that used it, in one record
 * per brand per month (`usage_meters`, `um_<tenantId>_<YYYY-MM>`). Every place that spends a
 * resource asks its meter first (`check`), then tells it what was spent (`record`).
 *
 * A record is one merged write of increments (never a read and a transaction), so many calls at
 * once never wait on each other. It adds the units by purpose and, from learning loops step 5, one
 * call by purpose (`callsByPurpose`), which the loops' heartbeat reads for uses of each purpose. The check counts first and the call runs after, as the other
 * monthly caps do, so calls at once can go a little past a cap. A failed write never fails the
 * work it was counting.
 */

/** A call that wasn't made: the brand has used this resource for the month. */
export interface UsageLimited {
  limited: true;
  used: number;
  limit: number;
}

export interface UsageMeter {
  /** Before spending `units` (1 by default): null to go ahead, or the cap reached. */
  check(units?: number): Promise<UsageLimited | null>;
  /**
   * `lost`: the call failed after it may have spent units, so they couldn't be counted. `model`: AI
   * model use only. `sameCall`: another record of a use already counted (a chat turn's second
   * model), so its units count but no second call by purpose.
   */
  record(units: number, opts?: { lost?: boolean; model?: string; sameCall?: boolean }): Promise<void>;
}

export interface MeterDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

export const meterMonth = (d: Date) => d.toISOString().slice(0, 7);
export const usageMeterId = (tenantId: string, month: string) => `um_${tenantId}_${month}`;
const nowOf = (deps: MeterDeps) => (deps.now ?? (() => new Date()))();

const EMPTY: ResourceCount = { total: 0, calls: 0, lostCalls: 0, byPurpose: {} };

/** A brand's usage of every resource this month (or another month), as counted. */
export async function usageThisMonth(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  deps: MeterDeps & { month?: string } = {},
): Promise<Partial<Record<ResourceId, ResourceCount>>> {
  const month = deps.month ?? meterMonth(nowOf(deps));
  const doc = await forTenant(ctx as TenantContext, deps.db).usageMeters.getById(usageMeterId(ctx.tenantId, month));
  return (doc?.meters ?? {}) as Partial<Record<ResourceId, ResourceCount>>;
}

/**
 * Purposes counted on a capped resource that never count toward its cap. Learning is never capped
 * (learning loops step 4, decision 3): the first remake of a held back image is metered under
 * loop_learn, so the holdback never uses up a brand's images.
 */
export const UNCAPPED_PURPOSES: ReadonlySet<ResourcePurpose> = new Set<ResourcePurpose>(["loop_learn"]);

/** The part of a month's count that counts toward its cap: all of it but what UNCAPPED_PURPOSES used. */
export function countedTowardCap(count: ResourceCount | null | undefined): number {
  if (!count) return 0;
  let n = count.total ?? 0;
  for (const p of UNCAPPED_PURPOSES) n -= count.byPurpose?.[p] ?? 0;
  return Math.max(0, n);
}

/** How much of one resource a brand used this month, as its cap counts it. */
export async function usedThisMonth(ctx: Pick<TenantContext, "tenantId" | "region">, resource: ResourceId, deps: MeterDeps = {}): Promise<number> {
  return countedTowardCap((await usageThisMonth(ctx, deps))[resource]);
}

/**
 * An organisation's usage this month: its brands' meters added up (each read by id, in its own
 * region). Null when a brand can't be read, so a total is never shown low.
 */
export async function organisationUsageThisMonth(
  brands: Array<Pick<TenantContext, "tenantId" | "region">>,
  deps: MeterDeps = {},
): Promise<Partial<Record<ResourceId, ResourceCount>> | null> {
  const out: Partial<Record<ResourceId, ResourceCount>> = {};
  const each = await Promise.all(brands.map((b) => usageThisMonth(b, deps).catch(() => null)));
  if (each.some((m) => m === null)) return null;
  for (const meters of each) {
    for (const [r, c] of Object.entries(meters!) as Array<[ResourceId, ResourceCount]>) {
      out[r] = addCounts(out[r] ?? EMPTY, c);
    }
  }
  return out;
}

function addMaps(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
  const out = { ...(a ?? {}) };
  for (const [k, n] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}

export function addCounts(a: ResourceCount, b: ResourceCount): ResourceCount {
  const byModel = a.byModel || b.byModel ? { byModel: addMaps(a.byModel, b.byModel) } : {};
  const callsByPurpose = a.callsByPurpose || b.callsByPurpose ? { callsByPurpose: addMaps(a.callsByPurpose, b.callsByPurpose) } : {};
  return {
    total: (a.total ?? 0) + (b.total ?? 0),
    calls: (a.calls ?? 0) + (b.calls ?? 0),
    lostCalls: (a.lostCalls ?? 0) + (b.lostCalls ?? 0),
    byPurpose: addMaps(a.byPurpose, b.byPurpose),
    ...callsByPurpose,
    ...byModel,
  };
}

/**
 * The meter for one resource spent by one feature of one brand. `tenant`: the brand record when
 * the caller has it (saves a read for the cap).
 */
export function usageMeter<R extends ResourceId>(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  resource: R,
  purpose: ResourcePurpose,
  opts: MeterDeps & { tenant?: Tenant | null } = {},
): UsageMeter {
  return {
    async check(units = 1) {
      if (!isUsageMeterEnabled() || !isLimitedResource(resource) || UNCAPPED_PURPOSES.has(purpose)) return null;
      try {
        const [used, tenant] = await Promise.all([
          usedThisMonth(ctx, resource, opts),
          opts.tenant !== undefined ? Promise.resolve(opts.tenant) : getTenantById(ctx.tenantId).catch(() => null),
        ]);
        const limit = monthlyLimitOf(tenant, resource).limit;
        return used + Math.max(1, units) > limit ? { limited: true, used, limit } : null;
      } catch (err) {
        // A meter that can't be read doesn't stop the work: it is counted when it can be.
        console.warn(`[usage] ${ctx.tenantId} ${resource} check failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
        return null;
      }
    },
    async record(units, recordOpts = {}) {
      if (!isUsageMeterEnabled()) return;
      const n = Math.max(0, Math.floor(units));
      const lost = recordOpts.lost === true;
      const now = nowOf(opts);
      const month = meterMonth(now);
      const model = recordOpts.model?.trim().slice(0, 80);
      try {
        await forTenant(ctx as TenantContext, opts.db).usageMeters.increment(
          usageMeterId(ctx.tenantId, month),
          {
            meters: {
              [resource]: {
                total: n,
                calls: 1,
                lostCalls: lost ? 1 : 0,
                byPurpose: { [purpose]: n },
                // In the same merged increment: a call of this purpose, whatever it spent.
                ...(recordOpts.sameCall ? {} : { callsByPurpose: { [purpose]: 1 } }),
                ...(model ? { byModel: { [model]: n } } : {}),
              },
            },
          },
          { month, updatedAt: now.toISOString() },
        );
        console.info(`[usage] ${ctx.tenantId} ${resource} ${purpose} ${n}${model ? ` ${model}` : ""}${lost ? " lost" : ""}`);
      } catch (err) {
        console.warn(`[usage] ${ctx.tenantId} ${resource} record failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
      }
    },
  };
}

/**
 * One Gemini call's usage, for src/lib/agents/gemini.ts: its tokens always, and the web searches
 * or images it spends. Built once per call from the brand and the feature (`purpose`).
 */
export function aiUsage(ctx: Pick<TenantContext, "tenantId" | "region">, purpose: ResourcePurpose, opts: MeterDeps & { tenant?: Tenant | null } = {}): AiUsage {
  const meter = (r: ResourceId) => usageMeter(ctx, r, purpose, opts);
  // The brand's language, read once for this usage (the record the caller passed, else one read).
  let language: Promise<string> | null = null;
  return {
    check: (kind, units) => meter(kind === "searches" ? "web_searches" : "images").check(units),
    recordModel: (tokens, model, o) => meter("model_tokens").record(tokens, { ...o, model }),
    recordSearches: (n, o) => meter("web_searches").record(n, o),
    recordImages: (n) => meter("images").record(n),
    brandLanguage: () =>
      (language ??= (opts.tenant !== undefined ? Promise.resolve(opts.tenant) : getTenantById(ctx.tenantId).catch(() => null)).then(
        (tenant) => normalizeLocale(tenant?.defaultLocale) ?? DEFAULT_LOCALE,
      )),
  };
}
