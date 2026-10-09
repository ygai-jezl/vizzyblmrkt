import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection, fencedContext } from "@/lib/agents/prompts/compose";
import { generateText } from "@/lib/agents/gemini";
import {
  BlogArticleMetaSchema,
  CONTENT_PLAN_LIMITS,
  type BlogArticleMeta,
  type BlogBrief,
  type BlogSource,
  type ContentNode,
  type ContentPlan,
} from "@/lib/types/contentPlan";
import {
  allowedUrls,
  blogReference,
  formatEntities,
  formatLinks,
  formatQuestions,
  formatSources,
  hostOf,
  isCodeHostUrl,
  normalizeUrl,
  ownHosts,
  usableSources,
} from "./brief";
import { citableGaps, evaluateCitable, type CitableReport } from "./citable";
import { unsupportedFigures } from "./figures";
import { blogWriterThinkingBudget } from "./flags";
import { slugify } from "./markdown";

/**
 * The blog hub's writer. One call writes the article to the CITABLE structure from its
 * brief; then code — not the model — does the parts that must be exact:
 *
 *  - LINKS: every link in the copy must be on the brief's lists (the brand's own pages,
 *    the checked sources, the knowledge pages it was given). Any other link is taken out
 *    and reported; the words stay.
 *  - FIGURES: every figure is looked up in what the writer was given. One that appears
 *    nowhere is reported for a person to check.
 *  - DATE: the "Last updated" line is stamped from the server's clock.
 *  - CHECK: the article is read against the CITABLE checklist. If it fails an item, the
 *    writer gets ONE second pass, told exactly which gaps to close; the better of the
 *    two drafts is kept.
 */

/** Skip the second pass once the first has taken this long (the request has to return). */
const REPAIR_WINDOW_MS = 30_000;

export interface BlogDraftInput {
  plan: ContentPlan;
  node: ContentNode;
  brief: BlogBrief;
  brandName: string;
  /** The formatted knowledge block (may be ""), and the pages it came from. */
  knowledgeContext: string;
  knowledgeUrls: string[];
  /** The fenced operator proof block (may be ""). */
  proofBlock: string;
  brandVoice?: string | null;
  audience?: string | null;
  /** One pass only — the caller has a deadline. */
  quick?: boolean;
}

export interface BlogDraftDeps {
  generate?: typeof generateText;
  now?: () => Date;
}

export interface BlogDraft {
  body: string;
  meta: BlogArticleMeta;
  warnings: string[];
  report: CitableReport;
}

interface ParsedDraft {
  metaTitle: string;
  metaDescription: string;
  slug: string;
  body: string;
}

/** Read the writer's answer: three header lines, a "---" line, then the Markdown. Tolerates
 *  a missing header (the whole answer is then the article) and a wrapping code fence. */
export function parseDraft(raw: string): ParsedDraft {
  let text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const out: ParsedDraft = { metaTitle: "", metaDescription: "", slug: "", body: "" };
  const h1 = text.search(/^#\s+\S/m);
  const head = h1 > 0 ? text.slice(0, h1) : "";
  const pick = (key: string) => new RegExp(`^\\s*\\**${key}\\**\\s*:\\**\\s*(.+)$`, "im").exec(head)?.[1]?.trim() ?? "";
  out.metaTitle = pick("META_TITLE").slice(0, 120);
  out.metaDescription = pick("META_DESCRIPTION").slice(0, 320);
  out.slug = slugify(pick("SLUG"));
  out.body = (h1 >= 0 ? text.slice(h1) : text).trim();
  return out;
}

/** Put today's date in the "Last updated" line, straight under the title — replacing
 *  whatever date the writer put there, or adding the line if it left it out. */
export function stampLastUpdated(markdown: string, date: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const stamp = `*Last updated: ${date}*`;
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  const firstSection = lines.findIndex((l) => /^##\s+\S/.test(l));
  const existing = lines.findIndex(
    (l, i) => i > h1 && (firstSection === -1 || i < firstSection) && /^\W*last\s+updated\b/i.test(l),
  );
  if (existing !== -1) {
    lines[existing] = stamp;
    return lines.join("\n");
  }
  if (h1 === -1) return `${stamp}\n\n${markdown}`;
  lines.splice(h1 + 1, 0, "", stamp);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

const MD_LINK = /\[((?:[^\]\\]|\\.)+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * Keep only the links the brief allows. A link to anywhere else loses its target (the
 * words stay) and is reported. The {{hub_url}} token is left for the plan to fill in.
 * Code is left exactly as written — an address inside a code block or a `code` span is
 * something the reader is shown, not a link the article makes.
 */
export function enforceLinks(markdown: string, allowed: Set<string>): { body: string; removed: string[] } {
  const removed: string[] = [];
  const prose = (text: string): string => {
    const linked = text.replace(MD_LINK, (whole, label: string, href: string) => {
      if (/^\{\{\s*hub_url\s*\}\}$/.test(href) || /^#[\w-]+$/.test(href)) return whole;
      const n = normalizeUrl(href);
      if (n && allowed.has(n)) return whole;
      removed.push(href.slice(0, 300));
      return label;
    });
    // A bare URL in the prose is a link too — and one nobody listed. (The sentence's own
    // closing punctuation is not part of the address, and stays.)
    return linked.replace(
      /(^|[\s(])(https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?])/g,
      (whole, lead: string, url: string, offset: number) => {
        const before = linked.slice(Math.max(0, offset - 2), offset + lead.length);
        if (before.endsWith("](")) return whole; // the target of a kept link
        const n = normalizeUrl(url);
        if (n && allowed.has(n)) return whole;
        removed.push(url.slice(0, 300));
        return lead;
      },
    );
  };
  let fenced = false;
  const body = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // Outside a block, a `code` span is still code: only the text around it is prose.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 ? part : prose(part)))
        .join("");
    })
    .join("\n");
  return { body, removed: [...new Set(removed)].slice(0, 20) };
}

/** Cut an over-long article at the end of a block, never mid-sentence. */
function fitBody(markdown: string): { body: string; cut: boolean } {
  const max = CONTENT_PLAN_LIMITS.MAX_BODY_CHARS;
  if (markdown.length <= max) return { body: markdown, cut: false };
  const head = markdown.slice(0, max);
  const at = head.lastIndexOf("\n\n");
  return { body: (at > max * 0.5 ? head.slice(0, at) : head).trimEnd(), cut: true };
}

/**
 * Said under the sources when some of them came from the brand's cite sources: the list
 * then holds facts from two places, and the writer is to choose on merit alone. The
 * brand's own research can be among them, and a reader must be able to tell that it is
 * the brand's own finding, not an outside party's. Empty otherwise, so an article with
 * no cite source behind it is asked for exactly as before.
 */
function sourcesNote(sources: BlogSource[], own: Set<string>): string {
  if (!sources.some((s) => s.origin === "cited")) return "";
  const ownResearch = sources.some((s) => s.origin === "cited" && own.has(hostOf(s.url)));
  return (
    "\n(These facts come from sources the brand has chosen and from a web search. Every one was checked against its page. " +
    "Cite the ones that best support the point you are making — it makes no difference which of the two a fact came from — and you need not use them all." +
    (ownResearch
      ? " A source on the brand's own site is the brand's own research: cite it the same way, and say it is the brand's own finding, never an outside party's."
      : "") +
    ")"
  );
}

function buildTask(input: BlogDraftInput, today: string): string {
  const { plan, node, brief } = input;
  const primary = brief.primaryQuestion.trim() || plan.scope.spark.trim() || plan.name;
  const entities = formatEntities(brief.entities);
  const sources = usableSources(brief);
  return renderPrompt("content.blog_draft", {
    brand_name: input.brandName.replace(/["\n]/g, " ").slice(0, 120),
    primary_question: primary,
    spark: plan.scope.spark || "(none)",
    brief: node.brief || "(none)",
    today,
    questions: formatQuestions(brief),
    buyer_context: fencedContext(
      "What the operator knows buyers ask (leads for what to answer)",
      "buyer_questions",
      brief.buyerQuestions.replace(/<\/?\s*buyer_questions[^>]*>/gi, " "),
    ),
    entities: entities
      ? `ENTITIES — the things this article is about and how each relates to the brand. Name them where they fit; state a relationship only where the material supports it:\n${entities}`
      : "",
    knowledge_context: input.knowledgeContext,
    proof_assets: input.proofBlock,
    sources: formatSources(sources),
    sources_note: sourcesNote(sources, ownHosts(brief, [plan.strategy.hubUrl])),
    links: formatLinks(brief.links),
  });
}

interface Checked {
  body: string;
  meta: BlogArticleMeta;
  report: CitableReport;
  cut: boolean;
}

/** Everything code decides about a draft: the date, the links, the figures, the check. */
function checkDraft(raw: string, input: BlogDraftInput, reference: string, today: string): Checked | null {
  const parsed = parseDraft(raw);
  if (parsed.body.length < 200) return null;
  // A draft that forgot its title still has the question it was asked to answer.
  if (!/^#\s+\S/m.test(parsed.body)) {
    const title = input.brief.primaryQuestion.trim() || input.plan.scope.spark.trim() || input.plan.name;
    parsed.body = `# ${title.replace(/\s+/g, " ").slice(0, 140)}\n\n${parsed.body}`;
  }
  const allowed = allowedUrls(input.brief, [
    input.plan.strategy.hubUrl,
    ...input.knowledgeUrls.filter((u) => !isCodeHostUrl(u)),
  ]);
  const linked = enforceLinks(stampLastUpdated(parsed.body, today), allowed);
  const fitted = fitBody(linked.body);
  const year = Number(today.slice(0, 4));
  const meta = BlogArticleMetaSchema.parse({
    metaTitle: parsed.metaTitle,
    metaDescription: parsed.metaDescription,
    slug: parsed.slug,
    lastUpdated: today,
    unsupportedFigures: unsupportedFigures(fitted.body, reference, { ignoreYears: [year] })
      .slice(0, 20)
      .map((f) => f.slice(0, 60)),
    removedLinks: linked.removed,
  });
  const report = evaluateCitable(fitted.body, { brief: input.brief, meta, pageUrl: input.plan.strategy.hubUrl });
  return { body: fitted.body, meta, report, cut: fitted.cut };
}

/** Lower is better: figures nobody can trace matter most, then the checklist. */
function badness(c: Checked): number {
  return c.meta.unsupportedFigures.length * 1000 + c.meta.removedLinks.length * 100 + (100 - c.report.score);
}

export async function draftBlogArticle(input: BlogDraftInput, deps: BlogDraftDeps = {}): Promise<BlogDraft | null> {
  const generate = deps.generate ?? generateText;
  const clock = deps.now ?? (() => new Date());
  const started = clock().getTime();
  const today = clock().toISOString().slice(0, 10);
  const { plan, brief } = input;

  const task = buildTask(input, today);
  const compose = (t: string) =>
    composePrompt({
      identity: brandVoiceSection(input.brandVoice),
      userProfile: audienceSection(input.audience),
      task: t,
    });

  // Everything the writer was given — the only places a figure may come from.
  const reference = blogReference({
    plan,
    nodeBrief: input.node.brief,
    brief,
    knowledgeContext: input.knowledgeContext,
    proofBlock: input.proofBlock,
  });

  const thinking = { thinkingBudget: blogWriterThinkingBudget() };
  const raw = await generate(compose(task), thinking);
  let best = raw ? checkDraft(raw, input, reference, today) : null;
  if (!best) return null;

  // A figure nobody can trace is the fact check's to fix, sentence by sentence — not a
  // reason to rewrite the whole article.
  const gaps = citableGaps({ ...best.report, items: best.report.items.filter((it) => it.id !== "a_figures") });
  if (best.meta.removedLinks.length) {
    gaps.unshift("You linked to pages that are not on the two lists. Use only the listed URLs, copied exactly.");
  }
  if (gaps.length && !input.quick && clock().getTime() - started < REPAIR_WINDOW_MS) {
    const repair = renderPrompt("content.blog_repair", {
      draft_task: task,
      gaps: gaps.map((g) => `- ${g}`).join("\n"),
      draft: best.body.replace(/<\/?\s*draft\s*>/gi, " "),
    });
    const second = await generate(compose(repair), thinking).catch(() => null);
    const revised = second ? checkDraft(second, input, reference, today) : null;
    if (revised && badness(revised) < badness(best)) {
      // The header lines are easy to drop on a revision — keep the first pass's if so.
      revised.meta = {
        ...revised.meta,
        metaTitle: revised.meta.metaTitle || best.meta.metaTitle,
        metaDescription: revised.meta.metaDescription || best.meta.metaDescription,
        slug: revised.meta.slug || best.meta.slug,
      };
      best = revised;
    }
  }

  const title = best.report.outline.title ?? "";
  const meta: BlogArticleMeta = {
    ...best.meta,
    metaTitle: best.meta.metaTitle || title.slice(0, 120),
    slug: best.meta.slug || slugify(title),
  };
  const warnings = blogWarnings(meta, best.report);
  if (best.cut) warnings.push("article_too_long");
  return { body: best.body, meta, warnings, report: best.report };
}

/** The warnings a blog hub carries on its node, from what the checks found. */
export const BLOG_WARNINGS = ["unsupported_figures", "unlisted_links_removed", "citable_gaps"] as const;

export function blogWarnings(meta: BlogArticleMeta, report: CitableReport): string[] {
  const warnings: string[] = [];
  if (meta.unsupportedFigures.length) warnings.push("unsupported_figures");
  if (meta.removedLinks.length) warnings.push("unlisted_links_removed");
  if (report.items.some((it) => it.status === "fail")) warnings.push("citable_gaps");
  return warnings;
}
