import { describe, expect, it } from "vitest";
import { getPrompt } from "@/lib/agents/prompts/registry";
import { NO_DASHES, WRITING_RULES } from "./writingRules";

// Prompts that write copy a person publishes without the shared modular rules.
const WRITE_ON_THEIR_OWN = [
  "creative.draft_copy",
  "content.suggest_angle",
  "content.brand_notes_extract",
  "content.blog_note_asks",
  "content.blog_draft",
  "content.blog_draft_editorial",
  "content.blog_fact_check",
  "content.ebook_chat",
  "lifecycle.insight_line",
  "lifecycle.email_copy",
  "content.image_alt_text",
];

describe("no dashes in our copy", () => {
  it("is in the shared writing rules and in every prompt that writes copy on its own", () => {
    expect(WRITING_RULES).toContain(NO_DASHES);
    for (const id of WRITE_ON_THEIR_OWN) expect(getPrompt(id).template, id).toContain(NO_DASHES);
  });

  it("is kept by the shared rules themselves, and by the article's own formats", () => {
    expect(WRITING_RULES.replace(NO_DASHES, "")).not.toMatch(/[—–]/);
    const article = getPrompt("content.blog_draft").template;
    expect(article).toContain("each as [Title](URL), publisher, year");
    expect(article).toContain('("> "…" (Name, role)")');
  });

  it("the blog hero's picture brief keeps words out of the art", () => {
    const brief = getPrompt("content.blog_hero_brief").template;
    expect(brief).toContain("No text, words, letters, numbers, data charts or logos anywhere in the image");
    expect(brief.replace(/\[\[[a-z_]+\]\]/g, "")).not.toMatch(/[—–]/);
  });

  it("the chart prompt never lets a number be invented", () => {
    const chart = getPrompt("content.chart_from_copy").template;
    expect(chart).toContain("Use ONLY numbers written in the text, exactly as they are");
    expect(chart.replace(/\[\[[a-z_]+\]\]/g, "")).not.toMatch(/[—–]/);
  });
});
