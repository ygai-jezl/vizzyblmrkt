import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import type { Competitor } from "@/lib/types/competitor";
import { isCompetitorsEnabled } from "./flags";
import { advanceCompetitor, nextStep, type StepDeps } from "./steps";

/**
 * The scheduled side of Competitors: it rides the lifecycle tick (every 2 minutes, worker secret
 * only), after the journeys, with what is left of the request's time.
 *
 * Every tick it advances setups that are still running (a tab was closed mid-way); a cheap query
 * that usually finds nothing. About every 30 minutes it also reads each brand's competitors (at
 * most 10) and runs the weekly and monthly checks that are due. Brands without the feature
 * (GRANTED_ONLY_FEATURES) are skipped. One competitor's failure never stops the rest.
 */

export interface TickDeps extends StepDeps {
  listTenants?: () => Promise<Tenant[]>;
}

export interface CompetitorTickResult {
  tenants: number;
  advanced: number;
  failed: number;
  scanned: boolean;
}

/** The lifecycle tick runs every 2 minutes; one in 15 is about every 30 minutes. */
const TICK_MS = 120_000;
const SCAN_EVERY = 15;
/** No one competitor holds the tick longer than this. */
const PER_COMPETITOR_MS = 20_000;
/** Below this, nothing more is started. */
const MIN_LEFT_MS = 12_000;

const SETTING_UP: Competitor["status"][] = ["finding", "reading", "analysing"];

export function isScanTick(nowMs: number): boolean {
  return Math.floor(nowMs / TICK_MS) % SCAN_EVERY === 0;
}

export async function runCompetitorChecks(opts: { deadlineMs: number }, deps: TickDeps = {}): Promise<CompetitorTickResult> {
  const result: CompetitorTickResult = { tenants: 0, advanced: 0, failed: 0, scanned: false };
  if (!isCompetitorsEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  const scan = isScanTick(clock());
  result.scanned = scan;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => tenantMayUse(t, "competitors"));

  // What is due, across brands: setups always, checks on a scan tick.
  const due: Array<{ ctx: TenantContext; id: string }> = [];
  for (const t of tenants) {
    if (clock() >= opts.deadlineMs - MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const repo = forTenant(ctx, deps.db).competitors;
      const rows = scan ? await repo.find({ limit: 50 }) : await repo.find({ where: [["status", "in", SETTING_UP]], limit: 50 });
      result.tenants += 1;
      for (const c of rows) if (nextStep(c, clock())) due.push({ ctx, id: c.id });
    } catch (err) {
      console.warn(`[competitors] tenant ${t.id} (${t.region}) list failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }

  // Take turns across brands, starting somewhere new each tick.
  const offset = due.length ? Math.floor(clock() / TICK_MS) % due.length : 0;
  const order = [...due.slice(offset), ...due.slice(0, offset)];
  for (const { ctx, id } of order) {
    if (opts.deadlineMs - clock() < MIN_LEFT_MS) break;
    try {
      await advanceCompetitor(ctx, id, Math.min(opts.deadlineMs, clock() + PER_COMPETITOR_MS), deps);
      result.advanced += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[competitors] ${ctx.tenantId}/${id} check failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  return result;
}
