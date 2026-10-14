import { createHash } from "node:crypto";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { BRAND_MAP_PAGE_LIMITS as L, BrandMapPageFactsSchema, type BrandMapPageFacts } from "@/lib/types/brandMapPage";
import { EMPTY_BLOG_BRIEF, hostOf, normalizeUrl, ownHosts } from "./brief";
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
  const url = plan.strategy.hubUrl && /^https:\/\//i.test(plan.strategy.hubUrl) ? plan.strategy.hubUrl : null;
  // Links to the brand's own pages: the hosts on its brief, and the article's own.
  const own = ownHosts(brief, [url]);
  const self = url ? normalizeUrl(url) : "";
  const links = [
    ...new Set(
      (outline?.links ?? [])
        .map((l) => l.href)
        .filter((href) => /^https:\/\//i.test(href) && own.has(hostOf(href)))
        .map(normalizeUrl)
        .filter((href) => href && href !== self),
    ),
  ].slice(0, L.links);
  // Once written, the names it says; until then, the names it is to say.
  const names = brief.entities
    .filter((e) => !outline || mentionsName(outline.plain, e.name))
    .map((e) => e.name.slice(0, L.name))
    .slice(0, L.names);
  const state = hub?.status === "approved" ? "approved" : body ? "draft" : "planned";
  return BrandMapPageFactsSchema.parse({
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
  });
}

/** A short, stable hash of a row's facts. */
export function pageFingerprint(facts: BrandMapPageFacts): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}
