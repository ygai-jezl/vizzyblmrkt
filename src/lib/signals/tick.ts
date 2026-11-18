import { tenantMayUse } from "@/lib/plans/brandAccess";
import { listAllTenants } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { collectSignal, ownHostsOf, type CollectDeps } from "./collect";
import { dataForSeoConfigured } from "./dataforseo";
import { isSignalsDataForSeoEnabled } from "./flags";
import { judgeSignal } from "./judge";
import { dueSignals, getSignal, saveJudgement } from "./store";

/**
 * The signals lane of the lifecycle tick (every 2 minutes): collect the Google lookups DataForSEO
 * has finished, for brands with the `next_up` feature, taking turns across brands. A person
 * waiting usually has theirs collected sooner by the page itself; this catches the rest.
 */

export interface SignalTickDeps extends CollectDeps {
  listTenants?: () => Promise<Tenant[]>;
  clock?: () => number;
  judge?: typeof judgeSignal;
}

export interface SignalTickResult {
  tenants: number;
  ready: number;
  failed: number;
  waiting: number;
}

/** Lookups collected per tick, across brands. */
const COLLECTS_PER_TICK = 10;
/** One collect may take this long (a DataForSEO call has a 20 second timeout). */
const MIN_LEFT_MS = 22_000;
/** Judging what came back may take this long (the judge's Gemini call has a 15 second timeout). */
const JUDGE_LEFT_MS = 17_000;
const TICK_MS = 120_000;

export async function runSignals(opts: { deadlineMs: number }, deps: SignalTickDeps = {}): Promise<SignalTickResult> {
  const result: SignalTickResult = { tenants: 0, ready: 0, failed: 0, waiting: 0 };
  if (!isSignalsDataForSeoEnabled() || !dataForSeoConfigured(deps.env ?? process.env)) return result;
  const clock = deps.clock ?? Date.now;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => tenantMayUse(t, "next_up"));
  const offset = tenants.length ? Math.floor(clock() / TICK_MS) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];
  let collected = 0;
  for (const t of order) {
    if (collected >= COLLECTS_PER_TICK || opts.deadlineMs - clock() < MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const due = await dueSignals(ctx, COLLECTS_PER_TICK - collected, { ...deps, now: () => new Date(clock()) });
      if (!due.length) continue;
      result.tenants += 1;
      const own = await ownHostsOf(ctx, t, deps);
      for (const s of due) {
        if (collected >= COLLECTS_PER_TICK || opts.deadlineMs - clock() < MIN_LEFT_MS) break;
        collected += 1;
        const got = await collectSignal(ctx, s, own, { ...deps, now: () => new Date(clock()) });
        if (got === "ready") {
          result.ready += 1;
          // Judge it now when there is time, so brand search and later runs get only what fits;
          // otherwise the page judges it when someone opens it.
          if (opts.deadlineMs - clock() >= JUDGE_LEFT_MS) {
            const fresh = await getSignal(ctx, s.id, deps);
            const verdicts = fresh ? await (deps.judge ?? judgeSignal)(ctx, fresh, deps).catch(() => null) : null;
            if (fresh && verdicts) await saveJudgement(ctx, fresh.id, verdicts, deps);
          }
        }
        else if (got === "failed") result.failed += 1;
        else if (got === "not_yet") result.waiting += 1;
      }
    } catch (err) {
      console.warn(`[signals] collecting for ${t.id} failed:`, err instanceof Error ? err.message : "unknown");
    }
  }
  return result;
}
