import { describe, expect, it, vi } from "vitest";
import { NO_USAGE } from "@/lib/agents/gemini";
import { articleLabel } from "@/lib/content/blog/labels";
import { renderArticleHtml } from "@/lib/content/blog/markdown";
import { outlineArticle } from "@/lib/content/blog/outline";
import { SAMPLE_ARTICLE } from "@/lib/content/blog/testing/sampleArticle";
import type { ArticleWords } from "@/lib/types/translation";
import { remapAnchors, translateArticle } from "./translateArticle";

/** One approved article into another language (PAGE_LANGUAGES_ENABLED). The model is a stand-in. */

const SOURCE: ArticleWords = {
  metaTitle: "What is AI search visibility monitoring?",
  metaDescription: "How AI answer engines name brands, and how to measure it.",
  heroAlt: "A chart of share of voice",
  body: SAMPLE_ARTICLE,
};

const fr = (k: Parameters<typeof articleLabel>[1]) => articleLabel("fr", k);

/** A stand-in French version: the same shape, French labels, "FR " before each heading and paragraph. */
function fakeFrench(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      if (line === "{{date_line}}") return line;
      if (line === "> **Key facts**") return `> **${fr("keyFacts")}**`;
      if (line === "> **TL;DR**") return `> **${fr("tldr")}**`;
      if (line === "## Frequently asked questions") return `## ${fr("faq")}`;
      if (line === "## Next step") return `## ${fr("nextStep")}`;
      if (line === "## Sources") return `## ${fr("sources")}`;
      if (/^#{1,3} /.test(line)) return line.replace(/^(#{1,3}) /, "$1 FR ");
      if (/^[a-z]/i.test(line)) return `FR ${line}`;
      return line;
    })
    .join("\n");
}

const answer = (w: Partial<ArticleWords>) => JSON.stringify({ strings: Object.entries(w).map(([key, text]) => ({ key, text })) });
/** The body as the model gets it: the date line is a marker it keeps. */
const sent = SOURCE.body.replace("*Last updated: 2026-10-07*", "{{date_line}}");
const french = (over: Partial<ArticleWords> = {}) =>
  answer({ metaTitle: "Qu’est-ce que la surveillance ?", metaDescription: "Comment la mesurer.", heroAlt: "Un graphique", body: fakeFrench(sent), ...over });
function model(...answers: Array<string | null>) {
  const generate = vi.fn();
  for (const a of answers) generate.mockResolvedValueOnce(a);
  return generate;
}
const input = { words: SOURCE, from: "en", to: "fr", glossary: ["Acme"], author: null, note: false, usage: NO_USAGE };

describe("translateArticle", () => {
  it("keeps the article's boxes, FAQ and sources findable, with the date line in French", async () => {
    const generate = model(french());
    const res = await translateArticle(input, { generate });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = outlineArticle(res.fields.body);
    expect(out.keyFacts).toHaveLength(3);
    expect(out.tldr).toHaveLength(3);
    expect(out.faq).toHaveLength(3);
    expect(out.sources).toHaveLength(2);
    expect(res.fields.body).toContain(`*${fr("lastUpdated")}: 2026-10-07*`);
    expect(res.fields.body).not.toContain("{{date_line}}");
    expect(generate.mock.calls[0]![0]).toContain("{{date_line}}");
    const prompt = generate.mock.calls[0]![0] as string;
    expect(prompt).toContain("from English into French");
    expect(prompt).toContain(`"Key facts" as "${fr("keyFacts")}"`);
  });

  it("gives a translated box its English class, so a site's styles still find it", async () => {
    const res = await translateArticle(input, { generate: model(french()) });
    expect(res.ok && renderArticleHtml(res.fields.body)).toContain('class="callout key-facts"');
  });

  it("asks once more when a box is lost, then fails with the reason", async () => {
    const lost = french({ body: fakeFrench(sent).replace(`> **${fr("keyFacts")}**`, "") });
    const generate = model(lost, lost);
    expect(await translateArticle(input, { generate })).toEqual({ ok: false, tries: 2, reason: "A box (key facts or summary) was lost or changed its number of items." });
    expect(generate.mock.calls[1]![0]).toContain("A box (key facts or summary) was lost");
  });

  it("fails on a changed link", async () => {
    const moved = french({ body: fakeFrench(sent).replace("https://acme.example/pricing", "https://acme.example/fr/tarifs") });
    expect(await translateArticle(input, { generate: model(moved, moved) })).toMatchObject({ ok: false, reason: "The article changed, added or lost a link." });
  });

  it("fails when the date line's marker is lost", async () => {
    const lost = french({ body: fakeFrench(sent).replace("{{date_line}}", "") });
    expect(await translateArticle(input, { generate: model(lost, lost) })).toMatchObject({ ok: false, reason: "The article lost its date line marker {{date_line}}." });
  });

  it("tries once only when another call wouldn't fit before the deadline", async () => {
    const lost = french({ body: "# FR\n\nFR rien." });
    const generate = model(lost, lost);
    const res = await translateArticle({ ...input, deadlineMs: 1_000 + 30_000 }, { generate, now: () => 1_000 });
    expect(res).toMatchObject({ ok: false, tries: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("adds the translated note in the article's language when the brand wants it", async () => {
    const res = await translateArticle({ ...input, note: true }, { generate: model(french()) });
    expect(res.ok && res.fields.body.trimEnd().endsWith("*Traduit de l’original et vérifié par notre équipe.*")).toBe(true);
  });

  it("writes the labels in English for a French source going into English", async () => {
    const generate = model(answer({ ...SOURCE, body: sent }));
    await translateArticle({ ...input, words: { ...SOURCE, body: fakeFrench(SOURCE.body) }, from: "fr", to: "en" }, { generate });
    expect(generate.mock.calls[0]![0]).toContain(`"${fr("keyFacts")}" as "Key facts"`);
    expect(generate.mock.calls[0]![0]).toContain("from French into English");
  });
});

describe("in-page links", () => {
  it("follow their heading to its new id", () => {
    const source = "# T\n\nSee [the cost](#what-does-it-cost).\n\n## What does it cost?\n\nText.";
    const translated = "# T\n\nVoir [le coût](#what-does-it-cost).\n\n## Combien ça coûte ?\n\nTexte.";
    expect(remapAnchors(source, translated)).toContain("(#combien-ca-coute)");
  });
});

describe("questions in other scripts", () => {
  it("counts an FAQ question ending in an Arabic or full-width question mark", () => {
    const md = (q: string) => `# T\n\n## ${articleLabel("ar", "faq")}\n\n### ${q}\n\nجواب.\n`;
    expect(outlineArticle(md("ما هو؟")).faq).toHaveLength(1);
    expect(outlineArticle(`# T\n\n## ${articleLabel("ja", "faq")}\n\n### 何ですか？\n\n答え。\n`).faq).toHaveLength(1);
  });
});
