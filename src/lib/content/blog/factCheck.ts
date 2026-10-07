import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateTextWithDeadline } from "@/lib/agents/gemini";
import {
  BlogArticleMetaSchema,
  type BlogArticleMeta,
  type BlogBrief,
  type BlogCorrection,
  type ContentNode,
  type ContentPlan,
} from "@/lib/types/contentPlan";
import {
  allowedUrls,
  blogReference,
  formatEntities,
  formatLinks,
  formatSources,
  isCodeHostUrl,
  usableSources,
} from "./brief";
import { enforceLinks } from "./draft";
import { unsupportedFigures } from "./figures";
import { blogCheckerThinkingBudget } from "./flags";

/**
 * The blog hub's fact check — a second reader whose only job is to find what the brand's
 * own material does not say. The writer is told not to invent; it still does, most often
 * in the places a number-check can't see: what a plan includes, how a competitor works,
 * how "accurate" something is. So after an article is written (and whenever the operator
 * asks), a separate call compares the copy with the material and returns exact
 * sentence-level corrections, which code applies and records for the operator to see.
 *
 * Code keeps the last word: a correction is only applied where its OLD text is found
 * verbatim, it may not grow the copy, and the result goes back through the link list
 * and the figure check — a correction can't smuggle in a link or a number of its own.
 */

const MAX_CORRECTIONS = 12;

export interface FactCheckInput {
  plan: ContentPlan;
  node: ContentNode;
  brief: BlogBrief;
  brandName: string;
  knowledgeContext: string;
  knowledgeUrls: string[];
  proofBlock: string;
  timeoutMs?: number;
}

export interface FactCheckDeps {
  generate?: typeof generateTextWithDeadline;
  now?: () => Date;
}

export interface FactCheckResult {
  body: string;
  meta: BlogArticleMeta;
  /** How many corrections were applied on this run. */
  corrected: number;
  /** False when the checker could not be reached — the copy is unchanged and unchecked. */
  checked: boolean;
}

interface Proposed {
  old: string;
  next: string;
  why: string;
}

/** Read the checker's OLD / NEW / WHY lines. "OK" (or anything else) reads as no corrections. */
export function parseCorrections(raw: string): Proposed[] {
  const out: Proposed[] = [];
  let cur: Partial<Proposed> | null = null;
  const push = () => {
    if (cur?.old && cur.next !== undefined) out.push({ old: cur.old, next: cur.next, why: cur.why ?? "" });
    cur = null;
  };
  for (const line of (raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s*(OLD|NEW|WHY)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (m[1] === "OLD") {
      push();
      cur = { old: value };
    } else if (cur && m[1] === "NEW") {
      cur.next = /^delete\.?$/i.test(value) ? "" : value;
    } else if (cur && m[1] === "WHY") {
      cur.why = value.slice(0, 200);
    }
  }
  push();
  return out.slice(0, MAX_CORRECTIONS);
}

/** Where a list item or a table row starts, so taking its text out takes the whole line. */
function removeFrom(body: string, at: number, length: number): string {
  const lineStart = body.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = body.indexOf("\n", at + length);
  const end = lineEnd === -1 ? body.length : lineEnd;
  const before = body.slice(lineStart, at);
  const after = body.slice(at + length, end);
  // The text was the whole line (bar a list marker or a box's ">"): drop the line.
  if (/^\s*(?:>\s*)*(?:[-*+]|\d{1,3}[.)])?\s*$/.test(before) && after.trim() === "") {
    return body.slice(0, lineStart) + body.slice(lineEnd === -1 ? body.length : lineEnd + 1);
  }
  // One sentence of several: take it out and close the gap.
  return (body.slice(0, at).replace(/[ \t]+$/, "") + " " + body.slice(at + length).replace(/^[ \t]+/, "")).replace(
    / ([.,;:!?])/g,
    "$1",
  );
}

/**
 * Apply the corrections whose OLD text is in the copy exactly once... or at all: the
 * first occurrence is changed. One that isn't found verbatim is skipped (the checker
 * misquoted — nothing is guessed at), as is one that would grow the copy.
 */
export function applyCorrections(
  body: string,
  proposed: Proposed[],
): { body: string; applied: BlogCorrection[] } {
  let out = body;
  const applied: BlogCorrection[] = [];
  for (const p of proposed) {
    if (p.old.length < 12 || p.old === p.next) continue;
    if (p.next.length > p.old.length * 1.5 + 80) continue;
    // A heading is the article's structure, not a claim to rewrite; the date line is the system's.
    if (/^#{1,4}\s/.test(p.old) || /\blast\s+updated\b/i.test(p.old)) continue;
    const at = out.indexOf(p.old);
    if (at === -1) continue;
    out = p.next ? out.slice(0, at) + p.next + out.slice(at + p.old.length) : removeFrom(out, at, p.old.length);
    applied.push({ before: p.old.slice(0, 600), after: p.next.slice(0, 600), reason: p.why });
  }
  return { body: out.replace(/\n{3,}/g, "\n\n"), applied };
}

/** Everything the writer was given — the only places a claim may come from. */
function materialOf(input: FactCheckInput): string {
  const { plan, brief } = input;
  return [
    input.knowledgeContext,
    input.proofBlock,
    `The operator's angle: ${plan.scope.spark}`,
    brief.buyerQuestions ? `What the operator says buyers ask: ${brief.buyerQuestions}` : "",
    `Third-party sources the article may cite:\n${formatSources(usableSources(brief))}`,
    `The brand's own pages:\n${formatLinks(brief.links)}`,
    brief.entities.length
      ? `Entities the article may name, and how each relates to the brand:\n${formatEntities(brief.entities)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/<\/?\s*(material|article)\s*>/gi, " ");
}

export async function checkBlogFacts(input: FactCheckInput, deps: FactCheckDeps = {}): Promise<FactCheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const year = now.getUTCFullYear();
  const { node, brief, plan } = input;
  const current = BlogArticleMetaSchema.parse(node.blog ?? {});
  const material = materialOf(input);
  // The same reference the writer's figures were checked against.
  const reference = blogReference({
    plan,
    nodeBrief: node.brief,
    brief,
    knowledgeContext: input.knowledgeContext,
    proofBlock: input.proofBlock,
  });
  const figuresBefore = unsupportedFigures(node.body, reference, { ignoreYears: [year] });

  const raw = await (deps.generate ?? generateTextWithDeadline)(
    renderPrompt("content.blog_fact_check", {
      brand_name: input.brandName.replace(/["\n]/g, " ").slice(0, 120),
      today: now.toISOString().slice(0, 10),
      unsupported_figures: figuresBefore.length ? figuresBefore.slice(0, 20).join(", ") : "(none)",
      material,
      article: node.body.replace(/<\/?\s*(material|article)\s*>/gi, " "),
    }),
    { timeoutMs: input.timeoutMs ?? 75_000, temperature: 0, thinkingBudget: blogCheckerThinkingBudget() },
  ).catch(() => null);
  if (raw === null) return { body: node.body, meta: current, corrected: 0, checked: false };

  const { body: corrected, applied } = applyCorrections(node.body, parseCorrections(raw));
  // Code keeps the last word on links and figures, whatever the corrections said.
  const allowed = allowedUrls(brief, [plan.strategy.hubUrl, ...input.knowledgeUrls.filter((u) => !isCodeHostUrl(u))]);
  const linked = enforceLinks(corrected, allowed);
  const meta = BlogArticleMetaSchema.parse({
    ...current,
    unsupportedFigures: unsupportedFigures(linked.body, reference, { ignoreYears: [year] })
      .slice(0, 20)
      .map((f) => f.slice(0, 60)),
    removedLinks: [...new Set([...current.removedLinks, ...linked.removed])].slice(0, 20),
    checkedAt: now.toISOString(),
    // The record of what changed builds up across checks (newest first), capped.
    corrections: [...applied, ...current.corrections].slice(0, MAX_CORRECTIONS),
  });
  return { body: linked.body, meta, corrected: applied.length, checked: true };
}
