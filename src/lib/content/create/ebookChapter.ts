import { randomUUID } from "node:crypto";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { composePrompt, brandVoiceSection, audienceSection, fencedContext } from "@/lib/agents/prompts/compose";
import { WRITING_RULES } from "@/lib/content/writingRules";
import { CONTENT_PLAN_LIMITS, type EbookImageSlot } from "@/lib/types/contentPlan";
import { EBOOK_IMAGE_MARKER_RE, buildImageAnchor, sanitizeEbookHtml, sanitizeEbookHtmlCapped } from "./ebookHtml";

/**
 * eBook chapter generation. `buildChapterPrompt` composes the (streamed) prompt; the route
 * streams it via generateTextStream. `parseChapterImagePlaceholders` is PURE — it turns the
 * model's raw HTML (with `[[image: brief]]` markers) into sanitized bodyHtml + the image
 * SLOTS those markers anchor, so it's unit-testable without Gemini. A deterministic fallback
 * chapter always exists so a stream failure still yields a saveable chapter.
 */

const PROMPT_MAX_IMAGES = Math.min(4, CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER);
const PRIOR_TITLES_MAX = 12;

export interface EbookChapterPromptInput {
  bookTitle: string;
  spark: string;
  industryLens: string;
  priorChapterTitles: string[];
  chapterTitle: string;
  chapterSummary: string;
  /** Pre-formatted RAG block (may be ""). */
  knowledgeContext: string;
  proofAssets?: string[];
  brandVoice?: string | null;
  audience?: string | null;
}

export function buildChapterPrompt(input: EbookChapterPromptInput): string {
  const proof = (input.proofAssets ?? []).filter(Boolean).join("\n\n");
  const task = renderPrompt("content.ebook_chapter", {
    book_title: input.bookTitle,
    spark: input.spark || "(none provided)",
    industry_lens: input.industryLens || "(general audience)",
    prior_chapter_titles: input.priorChapterTitles.slice(0, PRIOR_TITLES_MAX).join("; ") || "(none yet)",
    chapter_title: input.chapterTitle,
    chapter_summary: input.chapterSummary || "(no summary)",
    knowledge_context: input.knowledgeContext || "",
    proof_assets: fencedContext("Proof / case-study material (weave in as facts)", "proof_assets", proof),
    max_images: PROMPT_MAX_IMAGES,
  });
  return composePrompt({
    identity: brandVoiceSection(input.brandVoice),
    communication: WRITING_RULES,
    userProfile: audienceSection(input.audience),
    task,
  });
}

/**
 * Turn raw model HTML into { bodyHtml, images }: each `[[image: brief]]` marker becomes an
 * image SLOT (status "placeholder", the brief as its contextPrompt) anchored in the HTML,
 * then the whole fragment is allowlist-sanitized. Extra markers past the per-chapter cap
 * are dropped. `makeId` is injectable for deterministic tests.
 */
export function parseChapterImagePlaceholders(
  rawHtml: string,
  makeId: () => string = () => `img_${randomUUID()}`,
): { bodyHtml: string; images: EbookImageSlot[] } {
  const images: EbookImageSlot[] = [];
  const capped = (rawHtml ?? "").slice(0, CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS);
  const withAnchors = capped.replace(EBOOK_IMAGE_MARKER_RE, (_m, brief: string) => {
    if (images.length >= CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER) return "";
    const id = makeId();
    images.push({
      id,
      status: "placeholder",
      imageAssetRef: null,
      aspect: "1:1",
      width: 100,
      contextPrompt: String(brief ?? "").trim().slice(0, 1000),
      imagePrompt: null,
    });
    return buildImageAnchor(id);
  });
  const bodyHtml = sanitizeEbookHtmlCapped(withAnchors, CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS);
  return { bodyHtml, images };
}

/** Deterministic chapter body when the stream is empty (Gemini off / errored). */
export function fallbackChapterHtml(chapterTitle: string, chapterSummary: string): string {
  return sanitizeEbookHtml(
    `<h2>${chapterTitle}</h2><p>${chapterSummary || "This chapter is ready to write — add your notes or regenerate."}</p>`,
  );
}
