import { createHash } from "node:crypto";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { BRAND_MAP_PAGE_LIMITS as L, BrandMapPageFactsSchema, type BrandMapPageFacts } from "@/lib/types/brandMapPage";
import { siteOf } from "@/lib/knowledge/site";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { articleAddressProblem } from "./address";
import { EMPTY_BLOG_BRIEF, hostOf, normalizeUrl, ownHosts, textKey } from "./brief";
import { meaningWords } from "./coverage";
import { mentionsName } from "./names";
import { outlineArticle } from "./outline";

/**
 * A blog article's row on the brand map: what its plan says about its page. Null for a plan
 * that is not a blog article. Server-only (the fingerprint hashes).
 */
export function buildPlanPage(plan: ContentPlan): BrandMapPageFacts | null {
  if (plan.topology.hubChannel !== "blog" || plan.strategy.objective === "email_sequence") return null;
  const hub = plan.graph.nodes.find((n) => n.type === "hub");
  const brief = plan.blog ?? EMPTY_BLOG_BRIEF;
  const body = hub?.body.trim() ? hub.body : "";
  const outline = body ? outlineArticle(body) : null;
  // Only an article's own address (https, not the home page): a wizard can still take others.
  const address = plan.strategy.hubUrl?.trim() ?? "";
  const url = address && !articleAddressProblem(address) ? address : null;
  // Links to the brand's own pages: the hosts on its brief, and the article's own.
  const own = ownHosts(brief, [url]);
  const self = url ? normalizeUrl(url) : "";
  const links = [
    ...new Set(
      (outline?.links ?? [])
        .map((l) => l.href)
        .filter((href) => /^https:\/\//i.test(href) && own.has(hostOf(href)))
        .map(normalizeUrl)
        .filter((href) => href && href !== self && href.length <= L.url),
    ),
  ].slice(0, L.links);
  // Once written, the names it says; until then, the names it is to say.
  const names = brief.entities
    .filter((e) => !outline || mentionsName(outline.plain, e.name))
    .map((e) => e.name.slice(0, L.name))
    .slice(0, L.names);
  // Live only at the address it was seen at.
  const live = url && hub?.blog?.live && normalizeUrl(hub.blog.live.url) === normalizeUrl(url) ? hub.blog.live : null;
  const state = live ? "live" : hub?.status === "approved" ? "approved" : body ? "draft" : "planned";
  return withDerivedFacts(BrandMapPageFactsSchema.parse({
    kind: "article",
    workspaceId: plan.workspaceId,
    planId: plan.id,
    url,
    title: (outline?.title || hub?.blog?.metaTitle || brief.primaryQuestion || plan.name).trim().slice(0, L.title),
    primaryQuestion: brief.primaryQuestion.trim().slice(0, L.question),
    primaryRef: brief.primaryRef ?? null,
    questions: brief.questions.slice(0, L.questions).map((q) => ({ text: q.question, ref: q.ref ?? null })),
    subjectId: brief.subjectId ?? null,
    names,
    links,
    state,
    liveAt: live?.at ?? null,
    // The buying situation it is written for (the map at any size only: off, the row is as before).
    ...(isBrandMapScaleEnabled() && brief.situationId ? { situationId: brief.situationId } : {}),
  }));
}

/**
 * With the map at any size on, a row also stores what can be worked out from its own facts,
 * so one subject's pages can be asked for directly: the map question ids it carries, the
 * word keys of what it says, its address normalised, and its meaningful words. Off, the row
 * is exactly as before (and so is its fingerprint).
 */
export function withDerivedFacts(facts: BrandMapPageFacts): BrandMapPageFacts {
  if (!isBrandMapScaleEnabled()) return facts;
  const said = [facts.primaryQuestion, facts.title, ...facts.questions.map((q) => q.text)].filter(Boolean);
  const unique = <T>(xs: T[]) => [...new Set(xs)];
  return {
    ...facts,
    refs: unique([facts.primaryRef, ...facts.questions.map((q) => q.ref)].filter((r): r is string => Boolean(r))).slice(0, L.questions + 1),
    textKeys: unique(said.map(textKey).filter((k) => k && k.length <= L.question * 2)).slice(0, L.questions + 2),
    urlKey: facts.url ? normalizeUrl(facts.url) || null : null,
    words: unique(said.flatMap(meaningWords).filter((w) => w.length <= 60)).sort().slice(0, L.words),
  };
}

/** A short, stable hash of a row's facts. */
export function pageFingerprint(facts: BrandMapPageFacts): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

/** A page already on the brand's site: its row id. The same address gives each brand its own row. */
export function sitePageId(tenantId: string, url: string): string {
  return `s_${createHash("sha256").update(`${tenantId}\n${url}`).digest("hex").slice(0, 32)}`;
}

/**
 * A page already on the brand's site, as a row: live, with its links to the brand's own pages
 * when the crawl kept them (null = never read), and the programme and source that read it.
 * Null for a page that is not on an own site, or whose address is past the row's limit.
 */
export function buildSitePage(
  page: { url: string; title: string; links?: string[] | null },
  own: Set<string>,
  from: { workspaceId: string; sourceId: string } | null = null,
): BrandMapPageFacts | null {
  const url = normalizeUrl(page.url);
  if (!url || url.length > L.url || !/^https:\/\//i.test(url) || !own.has(siteOf(url))) return null;
  const links = page.links
    ? [
        ...new Set(
          page.links.map(normalizeUrl).filter((l) => l && l !== url && l.length <= L.url && /^https:\/\//i.test(l) && own.has(siteOf(l))),
        ),
      ].slice(0, L.links)
    : [];
  const parsed = BrandMapPageFactsSchema.safeParse({
    kind: "site",
    ...(from ? { workspaceId: from.workspaceId, sourceId: from.sourceId } : {}),
    url,
    title: page.title.replace(/\s+/g, " ").trim().slice(0, L.title),
    links,
    linksKnown: Boolean(page.links),
    state: "live",
  });
  return parsed.success ? withDerivedFacts(parsed.data) : null;
}
