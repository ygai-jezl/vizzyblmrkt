import { retrieveSemanticKnowledgeContext, type ContextRetrievalRequest } from "@/lib/agents/knowledgeRetrieval";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { BlogBrief, ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { Workspace } from "@/lib/types/workspace";
import { fenceProof } from "@/lib/content/create/generateNode";
import { tenantDomains } from "@/lib/knowledge/site";
import { briefOf } from "./brief";
import { evaluateCitable } from "./citable";
import { BLOG_WARNINGS, blogWarnings } from "./draft";
import { checkBlogFacts, type FactCheckDeps } from "./factCheck";
import { isBlogCitableEnabled } from "./flags";
import { researchBlogBrief, type BlogResearchDeps, type BlogResearchResult } from "./research";
import { askOfPlan, fileArticleSuggestions, loadArticleMap, type MapDeps } from "./mapActions";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { mapQuestionsByWords } from "@/lib/brandMap/articleScale";
import { syncPlanPageSoftly } from "./pageActions";
import { rememberAuthor, withRememberedAuthor } from "./authors";
import { keepArticleSeen, matchSeen, refreshAnswers, type SeenDeps } from "./seen";
import { isBlogEditorialEnabled } from "./flags";
import { isBrandNotesEnabled, isBrandNotesQuestionsEnabled, isBrandNotesRestEnabled } from "@/lib/brandNotes/flags";
import type { BlogSeen } from "@/lib/types/contentPlan";

/**
 * The two things a blog hub does besides being written — research before, and the fact
 * check after — each as one call that reads the plan, does the work and saves the result.
 * Shared by the Create canvas's routes and Vizzy's `content_plan` canvas kind, so a blog
 * drafted from chat is researched and checked exactly as one made by hand.
 */

type WorkspaceBits = Pick<Workspace, "id" | "name" | "audience">;

export type BlogActionError = { ok: false; status: number; error: string };

/** A plan whose hub is a blog article written to the CITABLE structure. */
export function isCitableBlogPlan(plan: ContentPlan): boolean {
  return isBlogCitableEnabled() && plan.topology.hubChannel === "blog" && plan.strategy.objective !== "email_sequence";
}

/**
 * What the tenant record says about the brand: its own name, when it has one (the brand
 * an article is published by), and the domains it is known to own — its root domain, the
 * origins it allow-listed and the sending domains it verified. Research uses those to
 * tell the brand's own pages from everyone else's.
 */
async function tenantBrand(ctx: TenantContext): Promise<{ name: string | null; sites: string[] }> {
  try {
    const tenant = await getTenantById(ctx.tenantId);
    return { name: tenant?.tenantName?.trim() || null, sites: tenantDomains(tenant) };
  } catch {
    return { name: null, sites: [] };
  }
}

export type BlogResearchOutcome =
  | ({
      ok: true;
      brief: BlogBrief;
      /** With a brand map: how many names were respelled its way, and how many new ones were suggested for it. */
      map?: { respelled: number; suggested: number };
    } & Pick<BlogResearchResult, "searched" | "found">)
  | BlogActionError;

/** Research a blog plan's brief and save it on the plan. */
export async function researchPlanBlog(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan; timeoutMs?: number },
  deps: BlogResearchDeps & MapDeps = {},
): Promise<BlogResearchOutcome> {
  const { workspace, plan } = args;
  if (!isBlogCitableEnabled()) return { ok: false, status: 503, error: "unavailable" };
  if (!isCitableBlogPlan(plan)) return { ok: false, status: 409, error: "not_a_blog_plan" };
  // Read side by side: the tenant record, and the brand map (null with its flag off or none saved).
  // With the pages switch on, the map also says what is answered and open, for research.
  const [brand, map] = await Promise.all([tenantBrand(ctx), loadArticleMap(ctx, deps, { pages: true, planId: plan.id, ask: askOfPlan(plan) })]);
  // At any size, research matches the questions it found against the whole map.
  const mapWords = deps.mapWords ?? (map && isBrandMapScaleEnabled() ? (texts: string[]) => mapQuestionsByWords(ctx, texts, { db: deps.db }) : undefined);
  const result = await researchBlogBrief(
    { ctx, workspace, plan, brandName: brand.name, ownSites: brand.sites, timeoutMs: args.timeoutMs, map },
    { ...deps, ...(mapWords ? { mapWords } : {}) },
  );
  // An author named before has their role, bio and page filled in; what is typed now is kept for next time.
  result.brief = await withRememberedAuthor(ctx, result.brief, deps.db);
  await rememberAuthor(ctx, result.brief, deps.db);
  await updateContentPlan(ctx, workspace.id, plan.id, { blog: result.brief }, deps.db);
  // Its questions, subject and names are the page's facts on the brand map.
  await syncPlanPageSoftly(ctx, { workspaceId: workspace.id, planId: plan.id }, { db: deps.db });
  if (!result.mapFindings) return { ok: true, brief: result.brief, searched: result.searched, found: result.found };
  // Names this article uses that the map does not have go to the map as suggestions.
  const suggested = await fileArticleSuggestions(
    ctx,
    { plan: { id: plan.id, workspaceId: workspace.id, name: plan.name }, unknown: result.mapFindings.unknown, title: result.brief.primaryQuestion },
    deps,
  );
  return {
    ok: true,
    brief: result.brief,
    searched: result.searched,
    found: result.found,
    map: { respelled: result.mapFindings.respelled.length, suggested },
  };
}

export type BlogCheckOutcome = { ok: true; node: ContentNode; corrected: number; checked: boolean } | BlogActionError;

/** Fact-check a blog hub's copy against the brand's material, apply the corrections and save. */
export async function checkPlanBlogFacts(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan; nodeId: string; timeoutMs?: number },
  deps: FactCheckDeps & MapDeps & { retrieve?: typeof retrieveSemanticKnowledgeContext } = {},
): Promise<BlogCheckOutcome> {
  const { workspace, plan } = args;
  if (!isBlogCitableEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const node = plan.graph.nodes.find((n) => n.id === args.nodeId);
  if (!node) return { ok: false, status: 404, error: "node_not_found" };
  if (!isCitableBlogPlan(plan) || node.type !== "hub" || node.channel !== "blog") {
    return { ok: false, status: 409, error: "not_a_blog_hub" };
  }
  if (!node.body.trim()) return { ok: false, status: 409, error: "nothing_to_check" };
  // Approved or scheduled copy is a person's decision — the check never rewrites it.
  if (node.status === "approved" || node.distributionStatus || node.scheduledAt) {
    return { ok: false, status: 409, error: "node_locked" };
  }

  // The same grounding the writer had (same question, same number of chunks), and the live
  // answers to the questions it asked its team.
  const brief = await refreshAnswers(ctx, briefOf(plan), { db: deps.db }, `${workspace.id}/${plan.id}`);
  const scopedTopic = plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const req: ContextRetrievalRequest = {
    ctx,
    ownerKind: "workspace",
    ownerId: workspace.id,
    queryText: brief.primaryQuestion.trim() || node.brief || plan.scope.spark || node.role,
    limit: 12,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  };
  const [rag, map] = await Promise.all([
    (deps.retrieve ?? retrieveSemanticKnowledgeContext)(req).catch(() => null),
    loadArticleMap(ctx, deps),
  ]);

  const result = await checkBlogFacts(
    {
      plan,
      node,
      brief,
      // With a brand map, the brand is called what the map calls it.
      brandName: map?.identity.name.trim() || brief.publisherName.trim() || workspace.name,
      map,
      knowledgeContext: rag?.formatted ?? "",
      knowledgeUrls: (rag?.chunks ?? []).map((c) => c.sourceUri).filter(Boolean),
      proofBlock: fenceProof(plan.knowledge.proofAssets ?? []),
      timeoutMs: args.timeoutMs,
    },
    deps,
  );
  if (!result.checked) return { ok: false, status: 502, error: "check_unavailable" };

  // Refresh the warnings the checks own; leave any other warning as it was.
  const report = evaluateCitable(result.body, { brief, meta: result.meta, pageUrl: plan.strategy.hubUrl, map });
  const owned = new Set<string>(BLOG_WARNINGS);
  const warnings = [...node.warnings.filter((w) => !owned.has(w)), ...blogWarnings(result.meta, report)];
  let updated: ContentNode | null;
  try {
    updated = await updateContentPlanNode(
      ctx,
      workspace.id,
      plan.id,
      node.id,
      { body: result.body, blog: result.meta, warnings },
      deps.db,
    );
  } catch {
    return { ok: false, status: 422, error: "invalid_node" };
  }
  if (!updated) return { ok: false, status: 404, error: "node_not_found" };
  // The article is written: its author's details are kept for their next one, the notes it
  // was written with say so, and what a person wrote for it joins the brand's notes.
  await rememberAuthor(ctx, brief, deps.db);
  if (isBrandNotesEnabled()) {
    await keepArticleSeen(ctx, { article: `${workspace.id}/${plan.id}`, brief, used: result.meta.style === "editorial" }, { db: deps.db }).catch((err) =>
      console.error("[blog] keeping the article's notes failed", err),
    );
  }
  // The checked copy's names and links are the page's facts on the brand map.
  await syncPlanPageSoftly(ctx, { workspaceId: workspace.id, planId: plan.id }, { db: deps.db });
  return { ok: true, node: updated, corrected: result.corrected, checked: true };
}

export type BlogSeenOutcome = { ok: true; seen: BlogSeen } | BlogActionError;

/** Whether an article's notes can be matched: the brand's notes and the editorial writer that uses them. */
export function isSeenOn(): boolean {
  return isBrandNotesEnabled() && isBlogEditorialEnabled();
}

/** Whether an article's questions for its team are kept as open questions, each answered in its own box. */
export function isSeenQuestionsOn(): boolean {
  return isSeenOn() && isBrandNotesQuestionsEnabled();
}

/** Whether a note rests after an article uses it, and every article asks its team three new questions. */
export function isSeenRestOn(): boolean {
  return isSeenQuestionsOn() && isBrandNotesRestEnabled();
}

/**
 * Match a blog plan's article to the brand's notes (What we've seen) and save what was found on
 * its brief. Reads the persisted plan (the canvas saves first), so a note a person took out, one
 * they added and what they wrote are all kept.
 */
export async function matchPlanSeen(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan },
  deps: SeenDeps = {},
): Promise<BlogSeenOutcome> {
  const { workspace, plan } = args;
  if (!isSeenOn()) return { ok: false, status: 503, error: "unavailable" };
  if (!isCitableBlogPlan(plan)) return { ok: false, status: 409, error: "not_a_blog_plan" };
  // The live answers to its questions first: one removed on Brand › What we've seen is gone.
  const brief = await refreshAnswers(ctx, briefOf(plan), deps, `${workspace.id}/${plan.id}`);
  const brand = await tenantBrand(ctx);
  const seen = await matchSeen(
    ctx,
    {
      plan,
      brief,
      brandName: brief.publisherName.trim() || brand.name || workspace.name,
      audience: workspace.audience,
      article: { ref: `${workspace.id}/${plan.id}`, title: plan.name.trim() || brief.primaryQuestion },
    },
    deps,
  );
  await updateContentPlan(ctx, workspace.id, plan.id, { blog: { ...brief, seen } }, deps.db);
  return { ok: true, seen };
}
