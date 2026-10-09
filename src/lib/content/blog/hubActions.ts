import { retrieveSemanticKnowledgeContext, type ContextRetrievalRequest } from "@/lib/agents/knowledgeRetrieval";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
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

export type BlogResearchOutcome = ({ ok: true; brief: BlogBrief } & Pick<BlogResearchResult, "searched" | "found">) | BlogActionError;

/** Research a blog plan's brief and save it on the plan. */
export async function researchPlanBlog(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan; timeoutMs?: number },
  deps: BlogResearchDeps & { db?: FirestoreLike } = {},
): Promise<BlogResearchOutcome> {
  const { workspace, plan } = args;
  if (!isBlogCitableEnabled()) return { ok: false, status: 503, error: "unavailable" };
  if (!isCitableBlogPlan(plan)) return { ok: false, status: 409, error: "not_a_blog_plan" };
  const brand = await tenantBrand(ctx);
  const result = await researchBlogBrief(
    { ctx, workspace, plan, brandName: brand.name, ownSites: brand.sites, timeoutMs: args.timeoutMs },
    deps,
  );
  await updateContentPlan(ctx, workspace.id, plan.id, { blog: result.brief }, deps.db);
  return { ok: true, brief: result.brief, searched: result.searched, found: result.found };
}

export type BlogCheckOutcome = { ok: true; node: ContentNode; corrected: number; checked: boolean } | BlogActionError;

/** Fact-check a blog hub's copy against the brand's material, apply the corrections and save. */
export async function checkPlanBlogFacts(
  ctx: TenantContext,
  args: { workspace: WorkspaceBits; plan: ContentPlan; nodeId: string; timeoutMs?: number },
  deps: FactCheckDeps & { db?: FirestoreLike; retrieve?: typeof retrieveSemanticKnowledgeContext } = {},
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

  // The same grounding the writer had (same question, same number of chunks).
  const brief = briefOf(plan);
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
  const rag = await (deps.retrieve ?? retrieveSemanticKnowledgeContext)(req).catch(() => null);

  const result = await checkBlogFacts(
    {
      plan,
      node,
      brief,
      brandName: brief.publisherName.trim() || workspace.name,
      knowledgeContext: rag?.formatted ?? "",
      knowledgeUrls: (rag?.chunks ?? []).map((c) => c.sourceUri).filter(Boolean),
      proofBlock: fenceProof(plan.knowledge.proofAssets ?? []),
      timeoutMs: args.timeoutMs,
    },
    deps,
  );
  if (!result.checked) return { ok: false, status: 502, error: "check_unavailable" };

  // Refresh the warnings the checks own; leave any other warning as it was.
  const report = evaluateCitable(result.body, { brief, meta: result.meta, pageUrl: plan.strategy.hubUrl });
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
  return { ok: true, node: updated, corrected: result.corrected, checked: true };
}
