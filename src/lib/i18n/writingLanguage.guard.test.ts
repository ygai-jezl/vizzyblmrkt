import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPrompts } from "@/lib/agents/prompts/registry";

/**
 * Every prompt in the registry is either written in the brand's language (CONTENT_LANGUAGE_ENABLED)
 * or left as it is for a reason. A new prompt fails this test until it is put in one list.
 */

const SRC = join(process.cwd(), "src");

/** Prompts whose words a person reads, and the file that puts them in the brand's language. */
const WRITTEN_IN_BRAND_LANGUAGE: Record<string, string> = {
  "creative.draft_copy": "lib/agents/creative.ts",
  "content.templatize": "lib/content/templatize.ts",
  "content.templatize_repair": "lib/content/templatize.ts",
  "content.transform": "lib/content/deconstruct.ts",
  "content.architect": "lib/content/create/architect.ts",
  "content.architect_sequence": "lib/content/create/architect.ts",
  "content.node_brief": "lib/content/create/nodeBrief.ts",
  "content.hub_draft": "lib/content/create/generateNode.ts",
  "content.fill": "lib/content/create/generateNode.ts",
  // Both email writers go through draftEmailCopy.
  "content.email_fill": "lib/content/create/emailCopy.ts",
  "lifecycle.email_copy": "lib/content/create/emailCopy.ts",
  "content.suggest_angle": "lib/content/create/suggestAngle.ts",
  "next_up.pick": "lib/nextUp/pick.ts",
  "content.blog_research": "lib/content/blog/research.ts",
  "content.blog_research_editorial": "lib/content/blog/research.ts",
  "content.blog_facts": "lib/content/blog/research.ts",
  "content.blog_cited_facts": "lib/content/blog/research.ts",
  "content.blog_draft": "lib/content/blog/draft.ts",
  "content.blog_draft_editorial": "lib/content/blog/draft.ts",
  "content.blog_repair": "lib/content/blog/draft.ts",
  "content.blog_note_asks": "lib/content/blog/seen.ts",
  "content.blog_note_asks_reuse": "lib/content/blog/seen.ts",
  "content.blog_note_asks_fresh": "lib/content/blog/seen.ts",
  "content.blog_fact_check": "lib/content/blog/factCheck.ts",
  "content.blog_refresh_propose": "lib/content/blog/refreshPropose.ts",
  "brand.generate_voice": "lib/content/create/brandVoiceGen.ts",
  "brand.map_research": "lib/brandMap/research.ts",
  "brand.map_research_scale": "lib/brandMap/research.ts",
  "brand.map_situations": "lib/brandMap/findSituations.ts",
  "brand.map_situation_questions": "lib/brandMap/situationQuestions.ts",
  "brand.map_groups": "lib/brandMap/sortGroups.ts",
  "brand.strategy_propose": "lib/brandStrategy/propose.ts",
  "content.strategy_plan": "lib/contentStrategy/pillars.ts",
  "content.email_layout": "lib/content/create/generateEmailLayout.ts",
  "content.chart_from_copy": "lib/content/imageStyle/chartFromCopy.ts",
  "content.image_alt_text": "lib/content/blog/hero.ts",
  "content.ebook_toc": "lib/content/create/ebookToc.ts",
  "content.ebook_chapter": "app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/chapters/[chapterId]/generate/route.ts",
  "content.ebook_chat": "app/api/admin/workspace/[workspaceId]/content-plans/[planId]/ebook/chat/route.ts",
  "lifecycle.insight_line": "lib/lifecycle/prepare.ts",
  "next_action.compose": "lib/nextAction/compose.ts",
};

const IMAGE_BRIEF = "briefs the image model, which paints no words";
const READS = "reads or sorts what it is given; its answer is data, not copy";
const JUDGES = "judges or matches; nobody reads its words";

/** Prompts left as they are, and why. */
const LEFT_AS_THEY_ARE: Record<string, string> = {
  "creative.image_brief": IMAGE_BRIEF,
  "content.email_image_brief": IMAGE_BRIEF,
  "content.social_image_brief": IMAGE_BRIEF,
  "content.blog_hero_brief": IMAGE_BRIEF,
  "content.ebook_image_brief": IMAGE_BRIEF,
  "content.format_scene_brief": IMAGE_BRIEF,
  "content.analyze": READS,
  "content.segment": READS,
  "content.brand_notes_extract": "keeps the brand's notes in the words they were written in",
  "brand.extract_kit": READS,
  "brand.map_import": READS,
  "brand.map_import_place": READS,
  "brand.extract_palette": READS,
  "brand.extract_image_palette": READS,
  "brand.curate_website_palette": READS,
  "brand.generate_theme": READS,
  "content.style_profile_extract": READS,
  "content.style_profile_synthesize": "guidance for the image model",
  "content.post_patterns_synthesize": "guidance for other prompts, not copy",
  "content.trending_topics": "finds topics on the web for other prompts",
  "brand.competitor_find": "names competitors and their sites",
  "signals.judge_found": JUDGES,
  "content.blog_note_match": JUDGES,
  "content.brand_fit_judge": JUDGES,
  "content.post_pattern_judge": JUDGES,
  "content.editor_vizzy_selection": "keeps the language of the text it is asked to change",
  "content.editor_vizzy_whole": "keeps the language of the text it is asked to change",
  "competitors.find_site": READS,
  "competitors.analyse_site": "reads a competitor's site for the team",
  "competitors.summarise_posts": "sums up a competitor's posts for the team",
  "competitors.summarise_site_changes": "sums up a competitor's site changes for the team",
  "competitors.read_robots": READS,
  "competitors.read_sitemap": READS,
  "competitors.read_posts": READS,
  "competitors.read_article": READS,
  "competitors.read_article_google": READS,
  "onboarding.learn": "the welcome's own questions, in the words people answer with",
  "onboarding.voice": "the welcome's own voice call",
  "conversation.golden_data": "the waitlist voice chat, already in the visitor's launch language (languageDirective)",
};

describe("which prompts are written in the brand's language", () => {
  const ids = listPrompts().map((p) => p.id);

  it("puts every prompt in one list or the other", () => {
    const unsorted = ids.filter((id) => !(id in WRITTEN_IN_BRAND_LANGUAGE) && !(id in LEFT_AS_THEY_ARE));
    expect(unsorted, "add each new prompt to WRITTEN_IN_BRAND_LANGUAGE or LEFT_AS_THEY_ARE").toEqual([]);
    const both = ids.filter((id) => id in WRITTEN_IN_BRAND_LANGUAGE && id in LEFT_AS_THEY_ARE);
    expect(both).toEqual([]);
  });

  it("lists no prompt that isn't in the registry", () => {
    const known = new Set(ids);
    expect([...Object.keys(WRITTEN_IN_BRAND_LANGUAGE), ...Object.keys(LEFT_AS_THEY_ARE)].filter((id) => !known.has(id))).toEqual([]);
  });

  it("has the file for each written prompt put its prompt in the brand's language", () => {
    for (const [id, file] of Object.entries(WRITTEN_IN_BRAND_LANGUAGE)) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(/\b(inBrandLanguage|withWritingLanguage|writingLanguage)\(/.test(text), `${id}: ${file}`).toBe(true);
    }
  });
});
