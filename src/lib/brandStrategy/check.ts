import { listSituations } from "@/lib/brandMap/situations";
import { readBrandMap } from "@/lib/brandMap/store";
import { listRecentReadArticles } from "@/lib/competitors/articles";
import { listCompetitors } from "@/lib/competitors/store";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { brandStrategyDocId, StrategyCheckSchema, type StrategyCheck } from "@/lib/types/brandStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { checkDue, nextCheck, type LookInput } from "./checkRules";
import { isStrategyCheckEnabled } from "./flags";
import { parseBrandStrategy } from "./store";

/**
 * The weekly strategy check's scheduled side (STRATEGY_CHECK_ENABLED). It rides the lifecycle tick
 * (every 2 minutes, worker secret only) and runs about every 30 minutes, at a tick of its own so it
 * never adds to the competitors' scan. Each run looks at no more than 3 brands with an approved
 * strategy whose check is due, the one waiting longest first, within its budget. A look reads the
 * same as the Strategy tab's Against your competitors card (their articles read in the last four
 * months, the watched competitors, the buying situations and the brand map) and keeps the result on
 * the strategy record without moving its revision. Brands without Competitors or their articles
 * (GRANTED_ONLY_FEATURES) are skipped. One brand's failure never stops the rest: it is tried again
 * a day later. A row the look opens, or one about something new, counts made under strategy_check
 * (LOOPS_ENABLED, learning loops step 5); a look that keeps the same row counts nothing.
 */

const TICK_MS = 120_000;
/** One tick in 15 (about every 30 minutes), at offset 11: the scan is 0, connected data's lane 7. */
const EVERY = 15;
const OFFSET = 11;
const BRANDS_PER_RUN = 3;
/** Below this, nothing more is started. */
const MIN_LEFT_MS = 3_000;
const RETRY_MS = 86_400_000;

export function isCheckTick(nowMs: number): boolean {
  return Math.floor(nowMs / TICK_MS) % EVERY === OFFSET;
}

export interface CheckDeps {
  db?: FirestoreLike;
  now?: () => Date;
  listTenants?: () => Promise<Tenant[]>;
}

export interface StrategyCheckResult {
  brands: number;
  /** Brands looked at that have a row open in Review after the look. */
  open: number;
  failed: number;
}

/** What a look reads for one brand. A read that fails throws: an empty list would read as "they wrote nothing". */
export async function lookInput(ctx: TenantContext, tenant: Tenant, deps: CheckDeps, now: Date): Promise<Omit<LookInput, "focusIds">> {
  const loadTenant = async () => tenant;
  const [recent, competitors, situations, read] = await Promise.all([
    listRecentReadArticles(ctx, { db: deps.db, now: () => now, loadTenant }),
    listCompetitors(ctx, { db: deps.db }),
    listSituations(ctx, { db: deps.db }),
    readBrandMap(ctx, deps.db),
  ]);
  return {
    articles: recent.articles,
    competitors,
    situations: situations.filter((s) => s.status === "decided").map((s) => ({ id: s.id, text: s.text, questions: s.counts.questions, answered: s.counts.answered })),
    alternatives: read.state === "ok" ? read.map.names.filter((n) => n.kind === "alternative").map((n) => ({ name: n.name, aliases: n.aliases })) : [],
    nowMs: now.getTime(),
  };
}

/**
 * One brand's look: read, then keep the check worked out from the record as it is at the write, so
 * a dismissal or an approval that lands meanwhile is never undone. Answers the check kept, or null
 * when the brand has no approved strategy any more.
 */
export async function lookAtBrand(ctx: TenantContext, tenant: Tenant, deps: CheckDeps = {}): Promise<StrategyCheck | null> {
  const now = (deps.now ?? (() => new Date()))();
  const input = await lookInput(ctx, tenant, deps, now);
  const nowIso = now.toISOString();
  // The row open before this look, from the attempt that saved (a claim that runs again reads again).
  let openBefore: string | null = null;
  const kept = await forTenant(ctx, deps.db).brandStrategy.claim(brandStrategyDocId(ctx.tenantId), (current) => {
    const doc = parseBrandStrategy(current);
    if (!doc?.approved) return null;
    openBefore = doc.check?.open?.key ?? null;
    return { check: nextCheck(doc.check, doc.approved.at, { ...input, focusIds: doc.approved.focusSituationIds }, nowIso) };
  });
  const parsed = kept ? StrategyCheckSchema.nullable().safeParse((kept as { check?: unknown }).check ?? null) : null;
  const check = parsed?.success ? parsed.data : null;
  // A new row in Review, as Review counts one: made once (a gap line, so the read is free).
  if (check?.open && check.open.key !== openBefore) {
    await countMade(ctx, "strategy_check", (await learnedFor(ctx, "strategy_check")).stamp, { type: "brand_strategy", db: deps.db });
  }
  return check;
}

/** After a failed look: try again a day later, so one brand can't hold the queue. */
async function retryLater(ctx: TenantContext, deps: CheckDeps, nowMs: number): Promise<void> {
  await forTenant(ctx, deps.db)
    .brandStrategy.claim(brandStrategyDocId(ctx.tenantId), (current) => {
      const doc = parseBrandStrategy(current);
      if (!doc?.approved) return null;
      const base = doc.check ?? StrategyCheckSchema.parse({ since: doc.approved.at.slice(0, 10) });
      return { check: { ...base, nextAt: new Date(nowMs + RETRY_MS).toISOString() } };
    })
    .catch(() => null);
}

export async function runStrategyChecks(opts: { deadlineMs: number }, deps: CheckDeps = {}): Promise<StrategyCheckResult> {
  const result: StrategyCheckResult = { brands: 0, open: 0, failed: 0 };
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  if (!isStrategyCheckEnabled() || !isCheckTick(clock())) return result;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => t.status !== "suspended" && tenantMayUse(t, "competitors") && tenantMayUse(t, "competitor_articles"));
  const queue: Array<{ t: Tenant; ctx: TenantContext; at: number }> = [];
  for (const t of tenants) {
    if (opts.deadlineMs - Date.now() < MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const doc = parseBrandStrategy(await forTenant(ctx, deps.db).brandStrategy.getById(brandStrategyDocId(t.id)));
      if (!doc?.approved || !checkDue(doc.check, clock())) continue;
      const at = doc.check?.nextAt ? Date.parse(doc.check.nextAt) : 0;
      queue.push({ t, ctx, at: Number.isFinite(at) ? at : 0 });
    } catch (err) {
      console.warn(`[strategy-check] ${t.id} (${t.region}) read failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  queue.sort((x, y) => x.at - y.at);
  for (const { t, ctx } of queue) {
    if (result.brands >= BRANDS_PER_RUN || opts.deadlineMs - Date.now() < MIN_LEFT_MS) break;
    result.brands += 1;
    try {
      const check = await lookAtBrand(ctx, t, deps);
      if (check?.open) result.open += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[strategy-check] ${t.id} (${t.region}) look failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      await retryLater(ctx, deps, clock());
    }
  }
  return result;
}
