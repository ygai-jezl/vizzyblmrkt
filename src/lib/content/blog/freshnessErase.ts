import { dropSearchConsolePicks } from "@/lib/connectors/signals/planning";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { pageContentPlans, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { freshnessWatchId, fromSearchConsole, withoutSearchConsole } from "./freshnessPages";

/**
 * Article freshness after a Search Console connection's erase (Connectors 2, ADR-0012): the
 * freshness watch copies a connection's numbers into reason words ("losing clicks", "within
 * reach"), on each live article's Freshness card and on the brand's due list in `fw_<tenantId>`,
 * which Review, Next up and Vizzy read. Disconnect, Change property and every end of a part take
 * them away with the numbers they came from, whatever any switch says.
 *
 * The words don't say which connection they came from, so every Search Console reason goes, and
 * the watch is due again at once: its next look puts back what the connections still readable
 * show (BLOG_FRESHNESS_ENABLED). Next up picks that weighed Search Console go too.
 *
 * Two steps, so the erase can put the quick one first: the due list and Next up (two documents),
 * then every article the brand has, archived plans and programmes included, whatever the watch
 * itself looks at. The second reads every plan a page at a time within a deadline; when it runs
 * out of time, or a step fails, the erase stays pending and the lane's next try goes on from the
 * start (an article already cleared costs a read, never a write).
 */

/** How the article step reads every plan. */
export const FRESHNESS_CLEAR = {
  /** Programmes, or one programme's plans, read in one page. */
  PAGE: 50,
  /** The time the article step may take when its caller gives no deadline (a person's Disconnect, say). */
  BUDGET_MS: 10_000,
  /** No page is read and no article written with less than this left before the deadline. */
  MIN_LEFT_MS: 2_000,
} as const;

export interface ClearedDue {
  /** Due list items that had Search Console reasons taken off, and Next up picks dropped. */
  due: number;
  picks: number;
  /** A step failed: logged once, never thrown. */
  failed: boolean;
}

export interface ClearedArticles {
  /** Articles that had Search Console reasons taken off. */
  articles: number;
  /** A read or a write failed: logged once, never thrown. */
  failed: boolean;
  /** Every plan was read and every article that needed it written: false leaves the rest for the next try. */
  finished: boolean;
}

export type ClearedReasons = ClearedDue & ClearedArticles;

const warnOnce = (ctx: TenantContext, what: string) => console.warn(`[freshness] removing Search Console figures from ${what} failed in part for ${ctx.tenantId}`);

/**
 * The quick step, for one brand: those reasons off every item on the due list, the watch due now,
 * a look going on started over when it wrote any, and its count of erases moved on, so a look already running writes
 * none of them back (freshnessWatch.ts); then Next up picks that weighed Search Console. Idempotent
 * apart from that count, whatever any switch says, and it never throws.
 */
export async function clearSearchConsoleDue(ctx: TenantContext, deps: { db?: FirestoreLike; now?: Date } = {}): Promise<ClearedDue> {
  const out: ClearedDue = { due: 0, picks: 0, failed: false };
  const now = deps.now ?? new Date();
  try {
    await forTenant(ctx, deps.db).freshnessWatch.claim(freshnessWatchId(ctx.tenantId), (w) => {
      // A transaction may run this more than once: count afresh each time.
      out.due = 0;
      const due = w.due.map((d) => {
        if (!fromSearchConsole(d.reasons)) return d;
        out.due += 1;
        return { ...d, reasons: withoutSearchConsole(d.reasons) };
      });
      const sooner = !(Date.parse(w.nextAt) <= now.getTime());
      // A look going on that wrote a Search Console reason starts over, so the next one looks again
      // at the articles it already passed. One that wrote none (the lane trying a pending erase
      // again, say) goes on, or a look longer than the gap between tries would never finish.
      return {
        ...(out.due ? { due } : {}),
        ...(sooner ? { nextAt: now.toISOString() } : {}),
        ...(w.searchConsoleInLook ? { lookStartedAt: null, searchConsoleInLook: false } : {}),
        searchConsoleClears: (w.searchConsoleClears ?? 0) + 1,
      };
    });
  } catch {
    out.failed = true;
  }
  try {
    out.picks = await dropSearchConsolePicks(ctx, { db: deps.db, notShared: false });
  } catch {
    out.failed = true;
  }
  if (out.failed) warnOnce(ctx, "the due list");
  return out;
}

/**
 * The article step, for one brand: every programme (archived ones too) and every plan in each, a
 * page at a time in id order with no cap, and those reasons off each article that has them, through
 * the content plan writer with nothing else on the node changed. It stops before the deadline
 * (FRESHNESS_CLEAR.BUDGET_MS from now when none is given) and says it didn't finish. Idempotent,
 * whatever any switch says, and it never throws.
 */
export async function clearSearchConsoleArticles(ctx: TenantContext, deps: { db?: FirestoreLike; deadlineMs?: number } = {}): Promise<ClearedArticles> {
  const out: ClearedArticles = { articles: 0, failed: false, finished: false };
  const stopAt = (deps.deadlineMs ?? Date.now() + FRESHNESS_CLEAR.BUDGET_MS) - FRESHNESS_CLEAR.MIN_LEFT_MS;
  const late = () => Date.now() > stopAt;
  const clearPlan = async (workspaceId: string, planId: string, nodeId: string) => {
    try {
      const node = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {}, deps.db, {
        setFreshness: (stored) => (stored && fromSearchConsole(stored.reasons) ? { ...stored, reasons: withoutSearchConsole(stored.reasons) } : stored),
      });
      if (node) out.articles += 1;
    } catch {
      out.failed = true;
    }
  };
  const run = async (): Promise<boolean> => {
    let afterProgramme: string | null = null;
    for (;;) {
      if (late()) return false;
      const programmes = await forTenant(ctx, deps.db).workspaces.find({ orderBy: [["__name__", "asc"]], ...(afterProgramme ? { startAfter: [afterProgramme] } : {}), limit: FRESHNESS_CLEAR.PAGE });
      for (const ws of programmes) {
        let afterPlan: string | null = null;
        for (;;) {
          if (late()) return false;
          const page = await pageContentPlans(ctx, ws.id, { after: afterPlan, limit: FRESHNESS_CLEAR.PAGE }, deps.db);
          for (const plan of page.plans) {
            for (const node of plan.graph.nodes) {
              if (!fromSearchConsole(node.blog?.freshness?.reasons)) continue;
              if (late()) return false;
              await clearPlan(plan.workspaceId, plan.id, node.id);
            }
          }
          if (!page.next) break;
          afterPlan = page.next;
        }
      }
      if (programmes.length < FRESHNESS_CLEAR.PAGE) return true;
      afterProgramme = programmes[programmes.length - 1]!.id;
    }
  };
  try {
    out.finished = (await run()) && !out.failed;
  } catch {
    out.failed = true;
  }
  if (out.failed) warnOnce(ctx, "articles");
  return out;
}

/** Both steps, the quick one first. */
export async function clearSearchConsoleReasons(ctx: TenantContext, deps: { db?: FirestoreLike; now?: Date; deadlineMs?: number } = {}): Promise<ClearedReasons> {
  const due = await clearSearchConsoleDue(ctx, deps);
  const articles = await clearSearchConsoleArticles(ctx, deps);
  return { ...due, ...articles, failed: due.failed || articles.failed };
}
