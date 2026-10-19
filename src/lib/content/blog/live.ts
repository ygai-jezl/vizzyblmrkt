import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BlogArticleMetaSchema, type BlogArticleLive, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { articleAddressProblem } from "./address";
import { normalizeUrl } from "./brief";
import { outlineArticle } from "./outline";
import { fetchSourcePage } from "./research";
import { syncPlanPageSoftly } from "./pageActions";
import { isBlogHeroEnabled } from "@/lib/content/imageStyle/flags";

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
  /** The page carries a share image (og:image); only reported when asked for. */
  shareImage?: boolean;
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

/**
 * Is the page's title the article's? A site often adds its name ("… | Acme"), or cuts a long
 * one short. Only the start of the article's title counts when it was cut short (it ends in an
 * ellipsis) or covers most of it: a site that answers every address with its own name ("Acme
 * AI visibility") is not the article "Acme AI visibility platform for brands".
 */
export function titlesMatch(pageTitle: string, articleTitles: string[]): boolean {
  const page = foldTitle(pageTitle);
  if (!page) return false;
  const cut = /(…|\.{3})\s*$/.test(pageTitle.trim());
  return articleTitles.some((t) => {
    const want = foldTitle(t);
    if (!want) return false;
    return page.includes(want) || (page.length >= 16 && want.startsWith(page) && (cut || page.length >= want.length * 0.8));
  });
}

/** Open the address and compare titles. */
export async function checkLive(
  url: string,
  articleTitles: string[],
  fetchPage: (url: string) => Promise<{ title: string; refused?: boolean; ogImage?: string } | null> = fetchSourcePage,
  opts: { shareImage?: boolean } = {},
): Promise<LiveCheck> {
  const page = await fetchPage(url).catch(() => null);
  if (!page) return { reachable: false, refused: false, title: "", matched: false };
  if (page.refused) return { reachable: true, refused: true, title: "", matched: false };
  return {
    reachable: true,
    refused: false,
    title: page.title,
    matched: titlesMatch(page.title, articleTitles),
    ...(opts.shareImage ? { shareImage: Boolean(page.ogImage) } : {}),
  };
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
  if (args.action === "check") {
    const title = node.body.trim() ? outlineArticle(node.body).title : null;
    check = await checkLive(url, [title ?? "", meta.metaTitle], deps.fetchPage, { shareImage: isBlogHeroEnabled() });
    // A match is live; anything else leaves it as it was, and says why.
    if (!check.matched) return { ok: true, node, check };
  }
  // Seen live at this address before: it keeps the day it was first seen ("newer" and "older" go by it).
  const sameAddress = (stored: BlogArticleLive | null) => (stored && normalizeUrl(stored.url) === normalizeUrl(url) ? stored : null);
  const setLive = (stored: BlogArticleLive | null): BlogArticleLive | null => {
    const before = sameAddress(stored);
    if (args.action === "clear") return null;
    if (args.action === "check") {
      return { url, at: before?.at ?? at, by: "check", titleMatched: true, checkedAt: at, ...(check?.shareImage !== undefined ? { shareImage: check.shareImage } : {}) };
    }
    return {
      url,
      at: before?.at ?? at,
      by: "operator",
      titleMatched: before?.titleMatched ?? false,
      ...(before?.checkedAt ? { checkedAt: before.checkedAt } : {}),
      ...(before?.shareImage !== undefined ? { shareImage: before.shareImage } : {}),
    };
  };

  let updated: ContentNode | null;
  try {
    // Only the live mark is written, in the node's own transaction: the rest of its meta is
    // whatever is stored then, never this request's copy of it.
    updated = await updateContentPlanNode(ctx, args.workspaceId, plan.id, node.id, {}, deps.db, { setLive });
  } catch {
    return { ok: false, status: 422, error: "invalid_node" };
  }
  if (!updated) return { ok: false, status: 404, error: "node_not_found" };
  await syncPlanPageSoftly(ctx, { workspaceId: args.workspaceId, planId: plan.id }, { db: deps.db });
  return { ok: true, node: updated, check };
}
