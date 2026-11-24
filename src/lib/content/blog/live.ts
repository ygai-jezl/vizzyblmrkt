import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BlogArticleMetaSchema, type BlogArticleLive, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { articleAddressProblem } from "./address";
import { normalizeUrl } from "./brief";
import { outlineArticle } from "./outline";
import { fetchSourcePage } from "./research";
import { writeLiveMark } from "./foundLive";
import { isBlogHeroEnabled } from "@/lib/content/imageStyle/flags";
import { isBlogDatesEnabled, isBlogLiveWatchEnabled } from "@/lib/brandMap/flags";
import { nextDates } from "./dates";
import { markdownToText } from "@/lib/search/text";

/**
 * "Check it's live" (BRAND_MAP_PAGES_ENABLED): open the article's address and compare the
 * page's title with the article's. A match marks it live. A person can say it is live
 * (a site that turns the check away, or fills its title in late) or that it is not. A check
 * never takes "live" away: a site being down for a minute is not the article coming down.
 *
 * Found live (BLOG_LIVE_WATCH_ENABLED): the check reads the page's text as well, since a site
 * often gives a page its own title for search. Most of the article's text on the page is the
 * article, whatever the page is called.
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
  /** A heading on the page (its title or first <h1>) is the article's (the text check only). */
  heading?: boolean;
  /** How much of the article's text is on the page, 0 to 1 (the text check only). */
  textShare?: number;
  /** The dates the page gives itself, as written (BLOG_DATES_ENABLED reads them). */
  pageDates?: { published: string | null; modified: string | null };
}

/** What a check opens a page with: its title, first heading and text, when it could read them. */
export type PageReader = (
  url: string,
) => Promise<{ title: string; refused?: boolean; ogImage?: string; h1?: string; text?: string; dates?: { published: string | null; modified: string | null } } | null>;

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

// ---- The text check (BLOG_LIVE_WATCH_ENABLED) ------------------------------------------------

/** Words in a row that make one run. Six is long enough that two different articles on the same
 *  subject share almost none (measured: 0 to 3% between a brand's own articles). */
export const RUN_WORDS = 6;
/** Most of the article on the page: it is the article. */
export const LIVE_SHARE = 0.5;
/** With a heading that is the article's, a smaller share is enough (an article edited before it went up). */
export const HEADING_SHARE = 0.2;
/** An article this short (in runs) can't be told by its text: its heading decides. */
export const MIN_RUNS = 40;

const NAMED: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  ndash: " ", mdash: " ", hellip: "...", laquo: '"', raquo: '"', middot: " ", bull: " ", copy: " ", reg: " ", trade: " ",
};

/** Turn what entities a page's text still carries into characters (React writes &#x27;, WordPress &#8217;). */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

/** Lower case words, with quotes and apostrophes dropped ("don't" is "dont") and anything else that isn't a letter or digit a gap. */
function words(text: string): string[] {
  return decodeHtmlEntities(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’'"“”`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function runsOf(list: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + RUN_WORDS <= list.length; i += 1) out.add(list.slice(i, i + RUN_WORDS).join(" "));
  return out;
}

/**
 * How much of the article is on the page: the share of the article's own runs of six words that
 * the page's text holds. Only the article's runs count, so a page's menus and footer don't lower it.
 */
export function textShare(articleMarkdown: string, pageText: string): { share: number; runs: number } {
  const article = runsOf(words(markdownToText(articleMarkdown ?? "")));
  if (!article.size) return { share: 0, runs: 0 };
  const page = runsOf(words(pageText ?? ""));
  let found = 0;
  for (const r of article) if (page.has(r)) found += 1;
  return { share: Math.round((found / article.size) * 100) / 100, runs: article.size };
}

/**
 * Is the page the article? Most of its text there, or a heading that is the article's with some of
 * its text (an address a person saved). `strict` (a page found on the sitemap, which nobody chose)
 * takes most of the text only: a new article can share its title with an older page, and every
 * page carries the brand's own lines.
 */
export function pageMatches(
  page: { title: string; h1?: string; text?: string },
  article: { titles: string[]; body: string },
  opts: { strict?: boolean } = {},
): { matched: boolean; heading: boolean; textShare: number } {
  const titles = article.titles.filter((t) => t.trim());
  const heading = [page.title, page.h1 ?? ""].some((h) => h.trim() && titlesMatch(h, titles));
  const { share, runs } = textShare(article.body, page.text ?? "");
  const matched = opts.strict
    ? runs >= MIN_RUNS && share >= LIVE_SHARE
    : runs < MIN_RUNS
      ? heading
      : share >= LIVE_SHARE || (heading && share >= HEADING_SHARE);
  return { matched, heading, textShare: share };
}

/**
 * Open the address and compare. With the article's text (`body`, BLOG_LIVE_WATCH_ENABLED) it reads
 * the page's text and first heading too; without it, titles only, as before.
 */
export async function checkLive(
  url: string,
  articleTitles: string[],
  fetchPage: PageReader = fetchSourcePage,
  opts: { shareImage?: boolean; body?: string | null; strict?: boolean } = {},
): Promise<LiveCheck> {
  const page = await fetchPage(url).catch(() => null);
  if (!page) return { reachable: false, refused: false, title: "", matched: false };
  if (page.refused) return { reachable: true, refused: true, title: "", matched: false };
  const image = opts.shareImage ? { shareImage: Boolean(page.ogImage) } : {};
  const dated = page.dates ? { pageDates: page.dates } : {};
  if (opts.body == null) return { reachable: true, refused: false, title: page.title, matched: titlesMatch(page.title, articleTitles), ...image, ...dated };
  const m = pageMatches(page, { titles: articleTitles, body: opts.body }, { strict: opts.strict });
  return { reachable: true, refused: false, title: page.title, matched: m.matched, heading: m.heading, textShare: m.textShare, ...image, ...dated };
}

/** Check, mark or clear that a blog article is live at its address, and save it on the hub. */
export async function setArticleLive(
  ctx: TenantContext,
  args: { workspaceId: string; plan: ContentPlan; nodeId: string; action: LiveAction; day?: string },
  deps: { db?: FirestoreLike; fetchPage?: PageReader; now?: () => Date } = {},
): Promise<LiveOutcome> {
  const { plan } = args;
  if (plan.topology.hubChannel !== "blog" || plan.strategy.objective === "email_sequence") {
    return { ok: false, status: 409, error: "not_a_blog_plan" };
  }
  const node = plan.graph.nodes.find((n) => n.id === args.nodeId);
  if (!node || node.type !== "hub" || node.channel !== "blog") return { ok: false, status: 404, error: "node_not_found" };
  const url = plan.strategy.hubUrl?.trim() ?? "";
  if (args.action !== "clear" && (!url || articleAddressProblem(url))) return { ok: false, status: 409, error: "no_address" };

  // "It's live" can say the day it went up (BLOG_DATES_ENABLED): a day, never one still to come.
  const nowDate = (deps.now ?? (() => new Date()))();
  if (args.day !== undefined && (args.action !== "mark" || !isBlogDatesEnabled() || !validLiveDay(args.day, nowDate))) {
    return { ok: false, status: 400, error: "invalid_day" };
  }
  const meta = node.blog ?? BlogArticleMetaSchema.parse({});
  const at = nowDate.toISOString();
  let check: LiveCheck | null = null;
  if (args.action === "check") {
    const title = node.body.trim() ? outlineArticle(node.body).title : null;
    const body = isBlogLiveWatchEnabled() ? node.body : null;
    check = await checkLive(url, [title ?? "", meta.metaTitle], deps.fetchPage, { shareImage: isBlogHeroEnabled(), body });
    // A match is live; anything else leaves it as it was, and says why.
    if (!check.matched) return { ok: true, node, check };
  }
  const by = args.action === "check" ? "check" : "operator";
  const mark = (stored: BlogArticleLive | null) => (args.action === "clear" ? null : nextLiveMark(stored, { url, at, by, check }));

  let written: Awaited<ReturnType<typeof writeLiveMark>>;
  try {
    // Only the live mark is written (and, Found live on, the approval it brings), in the node's own
    // transaction: the rest of its meta is whatever is stored then, never this request's copy of it.
    written = await writeLiveMark(
      ctx,
      {
        workspaceId: args.workspaceId,
        plan,
        nodeId: node.id,
        mark,
        approve: isBlogLiveWatchEnabled() && args.action !== "clear",
        // Its dates come with the mark; "Not live" takes them away with it.
        ...(isBlogDatesEnabled()
          ? {
              dates: (stored: Parameters<typeof nextDates>[0], live: BlogArticleLive | null) =>
                live ? nextDates(stored, { page: pageDatesOf(check), liveAt: live.at, personDay: args.day ?? null, now: nowDate }) : undefined,
            }
          : {}),
      },
      { db: deps.db },
    );
  } catch {
    return { ok: false, status: 422, error: "invalid_node" };
  }
  if (!written) return { ok: false, status: 404, error: "node_not_found" };
  return { ok: true, node: written.node, check };
}

/** The dates a check read on the page: none recorded as none, and nothing when no page was read. */
export function pageDatesOf(check: LiveCheck | null): { published: string | null; modified: string | null } | null {
  if (!check?.reachable || check.refused) return null;
  return check.pageDates ?? { published: null, modified: null };
}

/** A day a person gives for "It's live": YYYY-MM-DD, and not after today (a day's grace for zones ahead of UTC). */
export function validLiveDay(day: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day && ms <= now.getTime() + 86_400_000;
}

/**
 * The live mark a check, or a person's word, leaves at an address, from the one stored. Seen live
 * at this address before, it keeps the day it was first seen ("newer" and "older" go by it) and an
 * approval it made.
 */
export function nextLiveMark(
  stored: BlogArticleLive | null,
  args: { url: string; at: string; by: "check" | "operator"; check?: LiveCheck | null; found?: "address" | "sitemap"; auto?: boolean },
): BlogArticleLive {
  const { url, at, check } = args;
  const before = stored && normalizeUrl(stored.url) === normalizeUrl(url) ? stored : null;
  const kept = before?.approvedOnLive ? { approvedOnLive: true } : {};
  if (args.by === "check") {
    return {
      url,
      at: before?.at ?? at,
      by: "check",
      titleMatched: check?.heading ?? true,
      checkedAt: at,
      ...(check?.shareImage !== undefined ? { shareImage: check.shareImage } : {}),
      ...(check?.textShare !== undefined ? { textShare: check.textShare, found: args.found ?? before?.found ?? "address" } : {}),
      ...(args.auto ? { auto: true } : {}),
      ...kept,
    };
  }
  return {
    url,
    at: before?.at ?? at,
    by: "operator",
    titleMatched: before?.titleMatched ?? false,
    ...(before?.checkedAt ? { checkedAt: before.checkedAt } : {}),
    ...(before?.shareImage !== undefined ? { shareImage: before.shareImage } : {}),
    ...kept,
  };
}
