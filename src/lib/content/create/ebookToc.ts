import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection } from "@/lib/agents/prompts/compose";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { WRITING_RULES } from "@/lib/content/writingRules";
import { CONTENT_PLAN_LIMITS, type EbookChapter, type EbookDoc } from "@/lib/types/contentPlan";

/**
 * Generate an eBook's table of contents — a title, subtitle, and chapter list — from the
 * Scope intake + RAG context. One Gemini call. Degrades gracefully: a deterministic
 * fallback ToC always returns (mirrors architect.ts) so the studio always has something
 * to confirm. Retrieval is done by the route (like the architect); this stays pure given
 * a pre-formatted `knowledgeContext`, so it's unit-testable without Firestore.
 */

const MIN_CHAPTERS = 5;
// Aim below the hard cap so the model leaves room for a manual add or two.
const PROMPT_MAX_CHAPTERS = Math.min(10, CONTENT_PLAN_LIMITS.MAX_CHAPTERS);
const TITLE_MAX = 200;
const SUMMARY_MAX = 1000;

export interface EbookTocInput {
  spark: string;
  topicLabels: string[];
  industryLens: string;
  /** Pre-formatted RAG block (may be ""). */
  knowledgeContext: string;
  brandVoice?: string | null;
  audience?: string | null;
  /** Used as the book title if the model returns none (the plan/workflow name). */
  fallbackTitle: string;
}

function newChapter(title: string, summary: string): EbookChapter {
  return {
    id: `ch_${randomUUID()}`,
    title: title.slice(0, TITLE_MAX) || "Untitled chapter",
    summary: summary.slice(0, SUMMARY_MAX),
    bodyHtml: "",
    status: "planned",
    images: [],
  };
}

/** Deterministic ToC when Gemini is off / errors / returns nothing usable. */
function fallbackToc(input: EbookTocInput): EbookDoc {
  const base = input.topicLabels.length
    ? input.topicLabels
    : ["Introduction", "The core idea", "Putting it into practice", "Conclusion"];
  const chapters = base
    .slice(0, PROMPT_MAX_CHAPTERS)
    .map((t) => newChapter(t, `What "${t}" means for ${input.industryLens || "your audience"}.`));
  return {
    title: (input.fallbackTitle || "Untitled eBook").slice(0, TITLE_MAX),
    subtitle: input.spark ? input.spark.slice(0, 300) : "",
    industryLens: input.industryLens.slice(0, 500),
    chapters,
    tocConfirmed: false,
    coverImage: null,
  };
}

export async function generateEbookToc(input: EbookTocInput): Promise<EbookDoc> {
  const task = renderPrompt("content.ebook_toc", {
    spark: input.spark || "(none provided)",
    topics: input.topicLabels.length ? input.topicLabels.join(", ") : "(none)",
    industry_lens: input.industryLens || "(general audience)",
    knowledge_context: input.knowledgeContext || "",
    min_chapters: MIN_CHAPTERS,
    max_chapters: PROMPT_MAX_CHAPTERS,
  });
  const prompt = composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });

  const raw = await generateText(prompt).catch(() => null);
  const j = raw ? (parseFirstJson(raw) as Record<string, unknown> | null) : null;
  if (!j || typeof j !== "object") return fallbackToc(input);

  const rawChapters = Array.isArray(j.chapters) ? j.chapters : [];
  const chapters: EbookChapter[] = [];
  for (const c of rawChapters) {
    const cand = c as { title?: unknown; summary?: unknown };
    const title = typeof cand?.title === "string" ? cand.title.trim() : "";
    if (!title) continue;
    chapters.push(newChapter(title, typeof cand?.summary === "string" ? cand.summary.trim() : ""));
    if (chapters.length >= CONTENT_PLAN_LIMITS.MAX_CHAPTERS) break;
  }
  if (chapters.length === 0) return fallbackToc(input);

  const title = typeof j.title === "string" && j.title.trim() ? j.title.trim() : input.fallbackTitle;
  const subtitle = typeof j.subtitle === "string" ? j.subtitle.trim() : "";
  return {
    title: (title || "Untitled eBook").slice(0, TITLE_MAX),
    subtitle: subtitle.slice(0, 300),
    industryLens: input.industryLens.slice(0, 500),
    chapters,
    tocConfirmed: false,
    coverImage: null,
  };
}
