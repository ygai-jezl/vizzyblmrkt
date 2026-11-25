import { dropSearchConsolePicks } from "@/lib/connectors/signals/planning";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { FreshnessReason, FreshnessReasonKind } from "@/lib/types/contentPlan";
import { freshnessWatchId, liveArticles } from "./freshnessPages";

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
 */

/** The reasons whose words carry Search Console's numbers. */
export const SEARCH_CONSOLE_REASONS: ReadonlySet<FreshnessReasonKind> = new Set<FreshnessReasonKind>(["losing_clicks", "within_reach"]);

const fromSearchConsole = (reasons: readonly FreshnessReason[] | undefined) => (reasons ?? []).some((r) => SEARCH_CONSOLE_REASONS.has(r.kind));
const withoutSearchConsole = (reasons: readonly FreshnessReason[]) => reasons.filter((r) => !SEARCH_CONSOLE_REASONS.has(r.kind));

export interface ClearedReasons {
  /** Due list items and live articles that had Search Console reasons taken off, and Next up picks dropped. */
  due: number;
  articles: number;
  picks: number;
  /** A step failed: logged once, never thrown. */
  failed: boolean;
}

/**
 * Take Search Console's numbers out of article freshness, for one brand. Idempotent, whatever any
 * switch says, and it never throws: a step that fails is logged once, with no brand content, and
 * the others still run, so the erase that calls it always finishes.
 * 1. The due list: those reasons off every item, and the watch due now.
 * 2. Each live article the watch looks at (its own listing and caps): those reasons off its
 *    freshness, through the content plan writer, nothing else on the node changed.
 * 3. Next up picks that weighed Search Console.
 */
export async function clearSearchConsoleReasons(ctx: TenantContext, deps: { db?: FirestoreLike; now?: Date } = {}): Promise<ClearedReasons> {
  const out: ClearedReasons = { due: 0, articles: 0, picks: 0, failed: false };
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
      if (!out.due && !sooner) return null;
      return { ...(out.due ? { due } : {}), ...(sooner ? { nextAt: now.toISOString() } : {}) };
    });
  } catch {
    out.failed = true;
  }
  try {
    for (const a of await liveArticles(ctx, deps.db)) {
      if (!fromSearchConsole(a.hub.blog?.freshness?.reasons)) continue;
      try {
        const node = await updateContentPlanNode(ctx, a.plan.workspaceId, a.plan.id, a.hub.id, {}, deps.db, {
          setFreshness: (stored) => (stored && fromSearchConsole(stored.reasons) ? { ...stored, reasons: withoutSearchConsole(stored.reasons) } : stored),
        });
        if (node) out.articles += 1;
      } catch {
        out.failed = true;
      }
    }
  } catch {
    out.failed = true;
  }
  try {
    out.picks = await dropSearchConsolePicks(ctx, { db: deps.db, notShared: false });
  } catch {
    out.failed = true;
  }
  if (out.failed) console.warn(`[freshness] removing Search Console figures from article freshness failed in part for ${ctx.tenantId}`);
  return out;
}
