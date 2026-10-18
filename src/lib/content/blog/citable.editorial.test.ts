import { describe, expect, it } from "vitest";
import { BlogArticleMetaSchema, BlogBriefSchema } from "@/lib/types/contentPlan";
import { citableGaps, evaluateCitable } from "./citable";
import { EDITORIAL_ARTICLE, EDITORIAL_BRIEF } from "./testing/editorialArticle";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

const meta = BlogArticleMetaSchema.parse({ style: "editorial" });
const check = (markdown: string, brief = EDITORIAL_BRIEF) =>
  evaluateCitable(markdown, { brief, meta, pageUrl: "https://acme.example/blog/how-often" });
const item = (markdown: string, id: string, brief = EDITORIAL_BRIEF) => check(markdown, brief).items.find((it) => it.id === id);

describe("the checklist for an editorial article", () => {
  it("reads the editorial shape: no Key facts, TL;DR or table required, and the Voice items", () => {
    const r = check(EDITORIAL_ARTICLE);
    const ids = r.items.map((it) => it.id);
    expect(ids).not.toContain("c_key_facts");
    expect(ids).not.toContain("b_tldr");
    expect(ids).not.toContain("b_table_list");
    expect(ids).toEqual(expect.arrayContaining(["v_experience", "v_brand", "v_tells", "v_boxes", "v_wrong", "v_focus"]));
    expect(r.items.filter((it) => it.status === "fail")).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(90);
    // Nothing failed, so no second pass.
    expect(citableGaps(r)).toEqual([]);
  });

  it("reads an article written before the editorial shape exactly as before", () => {
    const ids = evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF }).items.map((it) => it.id);
    expect(ids).toContain("c_key_facts");
    expect(ids.some((id) => id.startsWith("v_"))).toBe(false);
  });

  it("fails AI phrases, naming each, and asks for them in plain words", () => {
    const md = EDITORIAL_ARTICLE.replace("Most teams should check weekly", "Most teams should leverage a robust weekly check");
    const tells = item(md, "v_tells")!;
    expect(tells.status).toBe("fail");
    expect(tells.detail).toContain("“leverage”");
    expect(tells.fix).toContain("“robust”");
  });

  it("keeps the brand out of the opening and to twice in the body", () => {
    const opening = EDITORIAL_ARTICLE.replace("For most teams a weekly check", "For most Acme customers a weekly check");
    expect(item(opening, "v_brand")!.status).toBe("fail");
    const often = EDITORIAL_ARTICLE.replace("The most common mistake is", "Acme sees it. Acme says it. Acme knows it. Acme does it. The most common mistake is");
    expect(item(often, "v_brand")!.status).toBe("fail");
    expect(item(EDITORIAL_ARTICLE, "v_brand")!.status).toBe("pass");
  });

  it("fails a claim of experience no note backs, and passes it once the brand has a note for the article", () => {
    const md = EDITORIAL_ARTICLE.replace("Most teams should check weekly", "We have seen that most teams should check weekly");
    expect(item(md, "v_experience")!.status).toBe("fail");
    const withNote = BlogBriefSchema.parse({
      ...EDITORIAL_BRIEF,
      seen: { notes: [{ id: "n1", text: "Teams that checked daily stopped reading the results within a month." }] },
    });
    expect(item(md, "v_experience", withNote)!.status).toBe("pass");
    // A note nobody used is a warning, not a fail.
    expect(item(EDITORIAL_ARTICLE, "v_experience", withNote)!.status).toBe("warn");
    // No note and no claim: written as analysis, said plainly, and nothing for a rewrite to do.
    const plain = item(EDITORIAL_ARTICLE, "v_experience")!;
    expect([plain.status, plain.fix]).toEqual(["warn", ""]);
  });

  it("notices a section on alternatives when the question isn't about choosing, and boxes nobody asked for", () => {
    const off = EDITORIAL_ARTICLE.replace("## Common mistakes", "## What are the top alternatives to Rivalco?");
    expect(item(off, "v_focus")!.status).toBe("fail");
    expect(item(off, "v_wrong")!.status).toBe("warn");
    const boxed = EDITORIAL_ARTICLE.replace("**Key takeaways**", "> **Key facts**\n> - One.\n\n**Key takeaways**");
    expect(item(boxed, "v_boxes")!.status).toBe("warn");
  });
});

describe("filler and copied slogans", () => {
  it("fails a list that says the same thing about several items", () => {
    const md = EDITORIAL_ARTICLE.replace(
      "## Common mistakes",
      "## Common mistakes\n\n- **Rivalco:** An alternative in the AI visibility category.\n- **Othero:** An alternative in the AI visibility category.\n- **Thirdco:** An alternative in the AI visibility category.\n",
    );
    const r = item(md, "v_repeat")!;
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("an alternative in the ai visibility category");
    expect(item(EDITORIAL_ARTICLE, "v_repeat")!.status).toBe("pass");
  });

  it("fails link text copied from a page's slogan", () => {
    const brief = BlogBriefSchema.parse({
      ...EDITORIAL_BRIEF,
      links: [...EDITORIAL_BRIEF.links, { url: "https://acme.example/waitlist", label: "Speak Fluent AI. No Code Required.", intent: "convert", by: "research" }],
    });
    const md = EDITORIAL_ARTICLE.replace("[See what a weekly check costs](https://acme.example/pricing)", "[Speak Fluent AI. No Code Required.](https://acme.example/waitlist)");
    expect(item(md, "v_anchor", brief)!.status).toBe("fail");
    expect(item(EDITORIAL_ARTICLE, "v_anchor", brief)!.status).toBe("pass");
  });
});
