import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listRecentContentPlans, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { nextDates } from "./dates";
import { fetchSourcePage } from "./research";

/**
 * Fills in Published (and Updated, when the page says so) for blog articles that were live
 * before true dates were kept (BLOG_DATES_ENABLED). With `readPages`, each article's live page is
 * read once for its own dates; otherwise Published is when it was first seen live. An article that
 * already has dates is left alone, so it is safe to run again. Writes only the dates: the live
 * mark, the copy and the status stay as stored.
 */

export interface DatesBackfillCounts {
  /** Live blog articles looked at. */
  live: number;
  /** Given dates (or that would be, on a dry run). */
  dated: number;
  /** Of those, dated from the page's own date. */
  fromPage: number;
  /** Already had dates: left alone. */
  had: number;
}

export interface DatesBackfillDeps {
  db?: FirestoreLike;
  readPage?: (url: string) => Promise<{ dates?: { published: string | null; modified: string | null }; refused?: boolean } | null>;
  now?: () => Date;
}

const PLANS_PER_PROGRAMME = 500;

/** The live blog articles in one brand without dates yet. */
async function undated(ctx: TenantContext, deps: DatesBackfillDeps): Promise<{ live: number; had: number; todo: Array<{ plan: ContentPlan; hub: ContentNode }> }> {
  const programmes = await forTenant(ctx, deps.db).workspaces.find({ limit: 200 });
  const out = { live: 0, had: 0, todo: [] as Array<{ plan: ContentPlan; hub: ContentNode }> };
  for (const ws of programmes) {
    for (const plan of await listRecentContentPlans(ctx, ws.id, PLANS_PER_PROGRAMME, deps.db)) {
      const hub = plan.graph.nodes.find((n) => n.type === "hub" && n.channel === "blog");
      if (!hub?.blog?.live) continue;
      out.live += 1;
      if (hub.blog.dates?.published) out.had += 1;
      else out.todo.push({ plan, hub });
    }
  }
  return out;
}

export async function backfillBlogDates(ctx: TenantContext, opts: { apply: boolean; readPages: boolean }, deps: DatesBackfillDeps = {}): Promise<DatesBackfillCounts> {
  const now = (deps.now ?? (() => new Date()))();
  const found = await undated(ctx, deps);
  const counts: DatesBackfillCounts = { live: found.live, dated: 0, fromPage: 0, had: found.had };
  for (const { plan, hub } of found.todo) {
    const live = hub.blog!.live!;
    const read = opts.readPages ? await (deps.readPage ?? fetchSourcePage)(live.url).catch(() => null) : null;
    const page = read && !read.refused ? (read.dates ?? { published: null, modified: null }) : null;
    const dates = nextDates(undefined, { page, liveAt: live.at, now });
    if (!dates.published) continue;
    counts.dated += 1;
    if (dates.published.source === "page") counts.fromPage += 1;
    if (!opts.apply) continue;
    // In the node's own write: dates set meanwhile (a check, Found live) win over this.
    await updateContentPlanNode(ctx, plan.workspaceId, plan.id, hub.id, {}, deps.db, {
      setDates: (stored, mark) => stored ?? (mark ? nextDates(undefined, { page, liveAt: mark.at, now }) : undefined),
    });
  }
  return counts;
}
