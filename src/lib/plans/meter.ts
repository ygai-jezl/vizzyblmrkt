import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { ResourceCount, UsageMeterDoc } from "@/lib/types/usageMeter";
import { isWebSearchMeterEnabled } from "./flags";
import { isLimitedResource, monthlyLimitOf } from "./limits";
import type { ResourceId, ResourcePurpose } from "./resources";

/**
 * The usage meter: what a brand used of each paid resource (src/lib/plans/resources.ts) this
 * calendar month, by the feature that used it, in one record per brand per month
 * (`usage_meters`, `um_<tenantId>_<YYYY-MM>`). Every place that spends a resource builds a meter
 * with `usageMeter` and asks it first (`check`), then tells it what was spent (`record`).
 *
 * The check counts first and the call runs after, as the other monthly caps do, so two calls at
 * once can go a little past the cap. A failed write never fails the work it was counting.
 */

/** A call that wasn't made: the brand has used this resource for the month. */
export interface UsageLimited {
  limited: true;
  used: number;
  limit: number;
}

export interface UsageMeter {
  check(): Promise<UsageLimited | null>;
  /** `lost`: the call failed after it may have spent units, so they couldn't be counted. */
  record(units: number, opts?: { lost?: boolean }): Promise<void>;
}

export interface MeterDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

/** Each resource's switch: off, it is neither counted nor capped. */
const ON: Record<ResourceId, () => boolean> = {
  web_searches: isWebSearchMeterEnabled,
};

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

/** How much of one resource a brand used this month. */
export async function usedThisMonth(ctx: Pick<TenantContext, "tenantId" | "region">, resource: ResourceId, deps: MeterDeps = {}): Promise<number> {
  return (await usageThisMonth(ctx, deps))[resource]?.total ?? 0;
}

/**
 * An organisation's usage this month: its brands' meters added up (each read by id). For
 * organisation allowances; nothing enforces them yet.
 */
export async function organisationUsageThisMonth(
  brands: Array<Pick<TenantContext, "tenantId" | "region">>,
  deps: MeterDeps = {},
): Promise<Partial<Record<ResourceId, ResourceCount>>> {
  const out: Partial<Record<ResourceId, ResourceCount>> = {};
  const each = await Promise.all(brands.map((b) => usageThisMonth(b, deps).catch(() => ({}) as Partial<Record<ResourceId, ResourceCount>>)));
  for (const meters of each) {
    for (const [r, c] of Object.entries(meters) as Array<[ResourceId, ResourceCount]>) {
      out[r] = addCounts(out[r] ?? EMPTY, c);
    }
  }
  return out;
}

function addCounts(a: ResourceCount, b: ResourceCount): ResourceCount {
  const byPurpose = { ...a.byPurpose };
  for (const [p, n] of Object.entries(b.byPurpose ?? {})) byPurpose[p] = (byPurpose[p] ?? 0) + n;
  return { total: a.total + b.total, calls: a.calls + b.calls, lostCalls: a.lostCalls + b.lostCalls, byPurpose };
}

/**
 * The meter for one resource spent by one feature of one brand. `tenant`: the brand record when
 * the caller has it (saves a read for the cap).
 */
export function usageMeter<R extends ResourceId>(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  resource: R,
  purpose: ResourcePurpose<R>,
  opts: MeterDeps & { tenant?: Tenant | null } = {},
): UsageMeter {
  return {
    async check() {
      if (!ON[resource]() || !isLimitedResource(resource)) return null;
      try {
        const [used, tenant] = await Promise.all([
          usedThisMonth(ctx, resource, opts),
          opts.tenant !== undefined ? Promise.resolve(opts.tenant) : getTenantById(ctx.tenantId).catch(() => null),
        ]);
        const limit = monthlyLimitOf(tenant, resource).limit;
        return used >= limit ? { limited: true, used, limit } : null;
      } catch (err) {
        // A meter that can't be read doesn't stop the work: it is counted when it can be.
        console.warn(`[usage] ${ctx.tenantId} ${resource} check failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
        return null;
      }
    },
    async record(units, recordOpts = {}) {
      if (!ON[resource]()) return;
      const n = Math.max(0, Math.floor(units));
      const lost = recordOpts.lost === true;
      const now = nowOf(opts);
      const month = meterMonth(now);
      const at = now.toISOString();
      try {
        await forTenant(ctx as TenantContext, opts.db).usageMeters.upsert(
          usageMeterId(ctx.tenantId, month),
          () => ({ month, meters: { [resource]: addCounts(EMPTY, { total: n, calls: 1, lostCalls: lost ? 1 : 0, byPurpose: n ? { [purpose]: n } : {} }) }, updatedAt: at }),
          (current) => {
            const was = (current.meters?.[resource] as ResourceCount | undefined) ?? EMPTY;
            const next = addCounts({ ...EMPTY, ...was, byPurpose: { ...(was.byPurpose ?? {}) } }, { total: n, calls: 1, lostCalls: lost ? 1 : 0, byPurpose: n ? { [purpose]: n } : {} });
            return { meters: { ...(current.meters ?? {}), [resource]: next }, updatedAt: at } as Partial<UsageMeterDoc>;
          },
        );
        console.info(`[usage] ${ctx.tenantId} ${resource} ${purpose} ${n}${lost ? " lost" : ""}`);
      } catch (err) {
        console.warn(`[usage] ${ctx.tenantId} ${resource} record failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
      }
    },
  };
}
