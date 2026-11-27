import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@/lib/agents/gemini";
import { NO_USAGE } from "@/lib/agents/gemini";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { evaluateCitable } from "./citable";
import { datelineText, withDateLine, type Dateline } from "./dates";
import { authorBox, bylineOf, draftBlogArticle, stampDateLine, stampLastUpdated, type BlogDraftInput } from "./draft";
import { unsupportedFigures } from "./figures";
import { articleLabel, articleLabelDirective, dateLineLanguage, otherLabels } from "./labels";
import { lastUpdatedOf, renderArticleHtml } from "./markdown";
import { outlineArticle } from "./outline";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

/** The sample article with its fixed words in French, as a French brand's writer is told to write them. */
const FRENCH_ARTICLE = SAMPLE_ARTICLE.replace("*Last updated: 2026-10-07*", "*Dernière mise à jour : 2026-10-07*")
  .replace("> **Key facts**", "> **Faits clés**")
  .replace("> **TL;DR**", "> **En bref**")
  .replace("## Frequently asked questions", "## Questions fréquentes")
  .replace("## Next step", "## Prochaine étape");

describe("article labels", () => {
  it("come from the catalog, English for a language with no file", () => {
    expect(articleLabel("fr", "keyFacts")).toBe("Faits clés");
    expect(articleLabel("de", "faq")).toBe("Häufig gestellte Fragen");
    expect(articleLabel("it", "keyFacts")).toBe("Key facts");
    expect(articleLabel("es", "by", { name: "Ana Ruiz" })).toBe("Por Ana Ruiz");
  });

  it("list the other languages' words, never English's", () => {
    expect(otherLabels("keyFacts")).toContain("Faits clés");
    expect(otherLabels("keyFacts")).not.toContain("Key facts");
    // French writes Sources as English does: nothing to add.
    expect(otherLabels("sources")).not.toContain("Sources");
  });

  it("tell the writer which words to use, or to keep the English ones", () => {
    expect(articleLabelDirective("en")).toBe("");
    expect(articleLabelDirective("fr")).toContain('"Key facts" as "Faits clés"');
    expect(articleLabelDirective("fr")).toContain('"Frequently asked questions" as "Questions fréquentes"');
    expect(articleLabelDirective("it")).toContain("in English");
  });

  it("know a date line's language from its first words", () => {
    expect(dateLineLanguage("*Dernière mise à jour : 2026-10-07*")).toBe("fr");
    expect(dateLineLanguage("最終更新日: 2026-10-07")).toBe("ja");
    expect(dateLineLanguage("*Last updated: 2026-10-07*")).toBe("en");
    expect(dateLineLanguage("Something else")).toBe("en");
  });
});

describe("reading an article in another language", () => {
  it("finds the same boxes, sections and date in French as in English", () => {
    const en = outlineArticle(SAMPLE_ARTICLE);
    const fr = outlineArticle(FRENCH_ARTICLE);
    expect(fr.keyFacts).toEqual(en.keyFacts);
    expect(fr.tldr).toEqual(en.tldr);
    expect(fr.faq.length).toBe(en.faq.length);
    expect(fr.lastUpdated).toBe("2026-10-07");
    expect(fr.sections.length).toBe(en.sections.length);
  });

  it("reads the date line, and shows it in its own language", () => {
    expect(lastUpdatedOf("Dernière mise à jour : 2026-10-07")).toBe("2026-10-07");
    expect(lastUpdatedOf("Zuletzt aktualisiert: 2026-10-07 · Von Ana")).toBe("2026-10-07");
    const html = renderArticleHtml("# Titre\n\n*Dernière mise à jour : 2026-10-07*\n\nTexte.");
    expect(html).toContain('Dernière mise à jour: <time datetime="2026-10-07">');
    expect(renderArticleHtml(SAMPLE_ARTICLE)).toContain('Last updated: <time datetime="2026-10-07">');
  });

  it("writes the dateline in the article's language", () => {
    const dl: Dateline = { published: { iso: "2026-04-28", text: "28 Apr 2026" }, updated: { iso: "2026-11-24", text: "24 Nov 2026" }, known: true } as Dateline;
    expect(datelineText(dl)).toBe("Published 28 Apr 2026 · Updated 24 Nov 2026");
    expect(datelineText(dl, "", "fr")).toMatch(/^Publié 28 avr\.? 2026 · Mis à jour 24 nov\.? 2026$/);
    expect(withDateLine("# T\n\n*Dernière mise à jour : 2026-11-24*\n", dl)).toContain("*Publié ");
  });

  it("finds no figures in another language's date line", () => {
    expect(unsupportedFigures("*Dernière mise à jour : 2026-10-07*\n\nTexte.", "")).toEqual([]);
  });
});

describe("stamping an article in another language", () => {
  it("writes the date line in the language, and replaces the writer's own", () => {
    expect(stampLastUpdated("# Titre\n\nTexte.", "2026-11-26", "fr")).toContain("*Dernière mise à jour: 2026-11-26*");
    const replaced = stampLastUpdated("# Titre\n\n*Dernière mise à jour : 2020-01-01*\n\nTexte.", "2026-11-26", "fr");
    expect(replaced).toContain("2026-11-26");
    expect(replaced).not.toContain("2020-01-01");
    expect(stampLastUpdated("# Title\n\nText.", "2026-11-26")).toContain("*Last updated: 2026-11-26*");
  });

  it("writes the byline and the author box in the language", () => {
    const brief = { ...SAMPLE_BRIEF, author: "Ana Ruiz", authorRole: "Directrice", authorBio: "Ana écrit sur la recherche." };
    expect(bylineOf(brief, "fr")).toBe("Par Ana Ruiz, Directrice");
    expect(bylineOf(brief)).toBe("By Ana Ruiz, Directrice");
    expect(authorBox(brief, "de")).toMatch(/^## Über den Autor/);
    expect(stampDateLine("# T\n\nX.", "2026-11-26", "Par Ana", "fr")).toContain("*Dernière mise à jour: 2026-11-26 · Par Ana*");
  });
});

describe("the CITABLE check on an article in another language", () => {
  it("passes the French boxes and sections as it passes the English ones", () => {
    const status = (md: string, language?: string) =>
      Object.fromEntries(evaluateCitable(md, { brief: SAMPLE_BRIEF, meta: language ? ({ language } as never) : null }).items.map((i) => [i.id, i.status]));
    const en = status(SAMPLE_ARTICLE);
    const fr = status(FRENCH_ARTICLE, "fr");
    for (const id of ["b_tldr", "l_updated"]) if (id in en) expect(fr[id], id).toBe(en[id]);
  });

  it("leaves out the editorial checks that read English words", () => {
    const ids = (language?: string) =>
      evaluateCitable(FRENCH_ARTICLE, { brief: SAMPLE_BRIEF, meta: { style: "editorial", ...(language ? { language } : {}) } as never }).items.map((i) => i.id);
    expect(ids()).toContain("v_experience");
    expect(ids()).toContain("v_wrong");
    expect(ids("fr")).not.toContain("v_experience");
    expect(ids("fr")).not.toContain("v_wrong");
  });

  it("counts a question title ending in any script's question mark", () => {
    const title = (t: string) =>
      evaluateCitable(`# ${t}\n\nText.`, { brief: SAMPLE_BRIEF, meta: { language: "ja" } as never }).items.find((i) => i.id === "i_question")?.status;
    expect(title("AI検索とは？")).toBe("pass");
    expect(title("ما هو البحث؟")).toBe("pass");
  });
});

describe("drafting an article for a French brand", () => {
  const node = { id: "hub", type: "hub", channel: "blog", role: "Hub", brief: "Explain it.", body: "" } as unknown as ContentNode;
  const plan = {
    id: "p1",
    name: "Visibility guide",
    strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility", subscriberCount: null },
    scope: { topics: [], spark: "Buyers ask AI assistants for shortlists.", industryLens: "" },
    knowledge: { groundingScope: "global", proofAssets: [] },
  } as unknown as ContentPlan;
  const input = (usage: AiUsage): BlogDraftInput => ({
    plan,
    node,
    brief: SAMPLE_BRIEF,
    brandName: "Acme",
    knowledgeContext: "[Source: Customer story — https://acme.example/customers/harbor]\nHarbor's share of voice rose from 6% to 21%.",
    knowledgeUrls: ["https://acme.example/customers/harbor"],
    proofBlock: "",
    quick: true,
    usage,
  });
  const answer = `META_TITLE: Visibilité IA\nMETA_DESCRIPTION: Ce que c'est.\nSLUG: visibilite-ia\n---\n${FRENCH_ARTICLE}`;
  const now = () => new Date("2026-10-07T09:00:00.000Z");

  beforeEach(() => vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("asks for French with the French labels, and keeps the article's language", async () => {
    const prompts: string[] = [];
    const generate = async (p: string) => (prompts.push(p), answer);
    const d = await draftBlogArticle(input({ ...NO_USAGE, brandLanguage: async () => "fr" }), { generate: generate as never, now });
    expect(prompts[0]).toContain("WRITE IN French");
    expect(prompts[0]).toContain('"Key facts" as "Faits clés"');
    expect(d!.meta.language).toBe("fr");
    expect(d!.body).toContain("*Dernière mise à jour: 2026-10-07*");
    expect(d!.report.items.find((i) => i.id === "b_tldr")?.status).toBe("pass");
  });

  it("asks exactly as before for an English brand", async () => {
    const prompts: string[] = [];
    const generate = async (p: string) => (prompts.push(p), answer.replace(FRENCH_ARTICLE, SAMPLE_ARTICLE));
    const d = await draftBlogArticle(input({ ...NO_USAGE, brandLanguage: async () => "en" }), { generate: generate as never, now });
    expect(prompts[0]).not.toContain("WRITE IN");
    expect(d!.meta.language).toBeUndefined();
  });
});
