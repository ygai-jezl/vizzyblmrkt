import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BlogArticleMetaSchema, type BlogArticleLive, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { articleAddressProblem } from "./address";
import { outlineArticle } from "./outline";
import { fetchSourcePage } from "./research";
import { syncPlanPageSoftly } from "./pageActions";

/**
 * "Check it's live" (BRAND_MAP_PAGES_ENABLED): open the article's address and compare the
 * page's title with the article's. A match marks it live. A person can say it is live
 * (a site that turns the check away, or fills its title in late) or that it is not. A check
 * never takes "live" away: a site being down for a minute is not the article coming down.
 */

export type LiveAction = "check" | "mark" | "clear";

export interface LiveCheck {
  /** The page answered. */
  reachable: boolean;
  /** The site answered but would not let the check read it. */
  refused: boolean;
  /** The page's own title, as read. */
  title: string;
  /** It is the article's title. */
  matched: boolean;
}

export type LiveOutcome =
  | { ok: true; node: ContentNode; check: LiveCheck | null }
  | { ok: false; status: number; error: string };

const foldTitle = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’'"“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Is the page's title the article's? A site often adds its name ("… | Acme"), or shortens a long one. */
export function titlesMatch(pageTitle: string, articleTitles: string[]): boolean {
  const page = foldTitle(pageTitle);
  if (!page) return false;
  return articleTitles.some((t) => {
    const want = foldTitle(t);
    return Boolean(want) && (page.includes(want) || (page.length >= 16 && want.startsWith(page)));
  });
}

/** Open the address and compare titles. */
export async function checkLive(
  url: string,
  articleTitles: string[],
  fetchPage: (url: string) => Promise<{ title: string; refused?: boolean } | null> = fetchSourcePage,
): Promise<LiveCheck> {
  const page = await fetchPage(url).catch(() => null);
  if (!page) return { reachable: false, refused: false, title: "", matched: false };
  if (page.refused) return { reachable: true, refused: true, title: "", matched: false };
  return { reachable: true, refused: false, title: page.title, matched: titlesMatch(page.title, articleTitles) };
}

/** Check, mark or clear that a blog article is live at its address, and save it on the hub. */
export async function setArticleLive(
  ctx: TenantContext,
  args: { workspaceId: string; plan: ContentPlan; nodeId: string; action: LiveAction },
  deps: { db?: FirestoreLike; fetchPage?: Parameters<typeof checkLive>[2]; now?: () => Date } = {},
): Promise<LiveOutcome> {
  const { plan } = args;
  if (plan.topology.hubChannel !== "blog" || plan.strategy.objective === "email_sequence") {
    return { ok: false, status: 409, error: "not_a_blog_plan" };
  }
  const node = plan.graph.nodes.find((n) => n.id === args.nodeId);
  if (!node || node.type !== "hub" || node.channel !== "blog") return { ok: false, status: 404, error: "node_not_found" };
  const url = plan.strategy.hubUrl?.trim() ?? "";
  if (args.action !== "clear" && (!url || articleAddressProblem(url))) return { ok: false, status: 409, error: "no_address" };

  const meta = node.blog ?? BlogArticleMetaSchema.parse({});
  const at = (deps.now ?? (() => new Date()))().toISOString();
  let check: LiveCheck | null = null;
  let live: BlogArticleLive | null | undefined;
  if (args.action === "check") {
    const title = node.body.trim() ? outlineArticle(node.body).title : null;
    check = await checkLive(url, [title ?? "", meta.metaTitle], deps.fetchPage);
    // A match is live; anything else leaves it as it was, and says why.
    live = check.matched ? { url, at, by: "check", titleMatched: true } : undefined;
  } else {
    live = args.action === "mark" ? { url, at, by: "operator", titleMatched: false } : null;
  }
  if (live === undefined) return { ok: true, node, check };

  let updated: ContentNode | null;
  try {
    updated = await updateContentPlanNode(ctx, args.workspaceId, plan.id, node.id, { blog: { ...meta, live } }, deps.db);
  } catch {
    return { ok: false, status: 422, error: "invalid_node" };
  }
  if (!updated) return { ok: false, status: 404, error: "node_not_found" };
  await syncPlanPageSoftly(ctx, { workspaceId: args.workspaceId, planId: plan.id }, { db: deps.db });
  return { ok: true, node: updated, check };
}
