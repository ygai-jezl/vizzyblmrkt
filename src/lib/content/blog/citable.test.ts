import { describe, expect, it } from "vitest";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { CITABLE_LETTERS, citableGaps, evaluateCitable } from "./citable";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { projectArticleMap } from "./articleMap";

const statusOf = (md: string, id: string, ctx = {}) =>
  evaluateCitable(md, { brief: SAMPLE_BRIEF, ...ctx }).items.find((it) => it.id === id)!.status;

describe("the CITABLE check", () => {
  it("passes an article written to the structure, and covers every letter", () => {
    const r = evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF, pageUrl: "https://acme.example/blog/visibility" });
    expect(r.items.filter((it) => it.status !== "pass").map((it) => `${it.id}: ${it.detail}`)).toEqual([]);
    expect(r.score).toBe(100);
    // Every CITABLE letter; Voice (V) is read only on an editorial article.
    expect([...new Set(r.items.map((it) => it.letter))].sort()).toEqual(CITABLE_LETTERS.map((l) => l.letter).filter((l) => l !== "V").sort());
    expect(citableGaps(r)).toEqual([]);
  });

  it("fails a plain essay on the things that make it hard to cite", () => {
    const essay = `# Thoughts on visibility\n\n${"A long ramble about the future of search and why it matters. ".repeat(40)}`;
    const r = evaluateCitable(essay, { brief: SAMPLE_BRIEF });
    const failed = r.items.filter((it) => it.status === "fail").map((it) => it.id);
    expect(failed).toEqual(
      expect.arrayContaining(["c_bluf", "c_key_facts", "i_intents", "a_direct", "b_tldr", "b_table_list", "b_faq", "l_updated"]),
    );
    expect(r.score).toBeLessThan(30);
    // A failed draft gets a short, concrete list of what to change.
    const gaps = citableGaps(r);
    expect(gaps.length).toBeGreaterThan(3);
    expect(gaps.length).toBeLessThanOrEqual(8);
    expect(gaps.join(" ")).toContain("Key facts box");
  });

  it("reads each item off the article", () => {
    expect(statusOf(SAMPLE_ARTICLE.replace("*Last updated: 2026-10-07*", ""), "l_updated")).toBe("fail");
    expect(statusOf(SAMPLE_ARTICLE.replace("# What is AI search visibility monitoring?", "# Visibility monitoring"), "i_question")).toBe("warn");
    // A Key facts box whose facts carry no source link is only half done.
    const unlinked = SAMPLE_ARTICLE.replace(" [Example Research, 2026](https://research.example.org/buyers-2026)", "");
    expect(statusOf(unlinked, "c_key_facts")).toBe("warn");
    // Citing one third-party site where two are wanted.
    const oneSource = SAMPLE_ARTICLE.split("https://press.example.net/ai-search-converts").join("https://acme.example/product");
    expect(statusOf(oneSource, "t_third_party")).toBe("warn");
    // No link to the conversion page.
    const noConvert = SAMPLE_ARTICLE.replace("[pricing page](https://acme.example/pricing)", "pricing page");
    expect(statusOf(noConvert, "i_links")).toBe("warn");
  });

  it("puts untraceable figures and missing inputs in front of the operator", () => {
    const meta = BlogArticleMetaSchema.parse({ unsupportedFigures: ["38%", "$4 million", "77%"] });
    const invented = SAMPLE_ARTICLE.replace("## What does it cost?", "Churn fell 38% and revenue rose $4 million.\n\n## What does it cost?");
    const r = evaluateCitable(invented, { brief: SAMPLE_BRIEF, meta });
    const figures = r.items.find((it) => it.id === "a_figures")!;
    expect(figures.status).toBe("fail");
    expect(figures.detail).toContain("38%, $4 million");
    // That alone is worth a second pass, and the instruction names the figures.
    expect(citableGaps(r)[0]).toContain("38%, $4 million");
    // A figure that is no longer in the copy ("77%" here, and all three once the operator
    // edits the sentence out) is no longer reported.
    expect(r.figuresToCheck).toEqual(["38%", "$4 million"]);
    const edited = evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF, meta });
    expect(edited.figuresToCheck).toEqual([]);
    expect(edited.items.find((it) => it.id === "a_figures")!.status).toBe("pass");

    // With no pages or sources in the brief the article can't link or cite — say so, don't fail the writer.
    const bare = evaluateCitable(SAMPLE_ARTICLE, {});
    expect(bare.items.find((it) => it.id === "i_links")).toMatchObject({ status: "warn", fix: "" });
    expect(bare.items.find((it) => it.id === "t_third_party")).toMatchObject({ status: "warn", fix: "" });
  });

  it("does not ask for a source list when nothing third-party is cited", () => {
    const own = SAMPLE_ARTICLE.split("https://research.example.org/buyers-2026")
      .join("https://acme.example/product")
      .split("https://press.example.net/ai-search-converts")
      .join("https://acme.example/pricing")
      .replace(/## Sources[\s\S]*$/, "");
    expect(evaluateCitable(own, { brief: SAMPLE_BRIEF }).items.find((it) => it.id === "a_sources")).toMatchObject({
      status: "pass",
      detail: "Cites no third-party page, so there is nothing to list.",
    });
    const unlisted = SAMPLE_ARTICLE.replace(/## Sources[\s\S]*$/, "");
    expect(statusOf(unlisted, "a_sources")).toBe("warn");
  });

  it("warns without asking for a rewrite", () => {
    // One section is too long: a warning, but nothing failed, so no second pass.
    const long = SAMPLE_ARTICLE.replace("## What does it cost?\n", `## What does it cost?\n\n${"filler words here ".repeat(120)}\n`);
    const r = evaluateCitable(long, { brief: SAMPLE_BRIEF });
    expect(r.items.find((it) => it.id === "b_blocks")!.status).toBe("warn");
    expect(r.items.some((it) => it.status === "fail")).toBe(false);
    expect(citableGaps(r)).toEqual([]);
  });
});

describe("the CITABLE check with a brand map", () => {
  const mapWith = (identity: Record<string, unknown>) =>
    projectArticleMap({ ...BrandMapDecidedSchema.parse({ identity: { name: "Acme", ...identity } }), rev: 1 });
  const ids = (md: string, map: ReturnType<typeof mapWith> | null) => evaluateCitable(md, { brief: SAMPLE_BRIEF, map }).items.map((it) => it.id);

  it("is exactly as before without a map, or with a map that has nothing to check", () => {
    const before = evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF });
    expect(evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF, map: null })).toEqual(before);
    expect(evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF, map: mapWith({}) })).toEqual(before);
  });

  it("checks the article keeps to the map's names", () => {
    const map = mapWith({ category: "AI search visibility monitoring", avoid: [{ term: "GEO tool", useInstead: "AI search visibility monitoring" }] });
    expect(ids(SAMPLE_ARTICLE, map)).toContain("l_names");
    expect(statusOf(SAMPLE_ARTICLE, "l_names", { map })).toBe("pass");
    // Another wording of the category in the opening: a warning.
    const reworded = SAMPLE_ARTICLE.replace(
      "Acme Visibility is an AI search visibility monitoring platform built for B2B marketing teams.",
      "Acme Visibility is a platform built for B2B marketing teams.",
    ).replace("AI search visibility monitoring is the practice", "It is the practice");
    expect(statusOf(reworded, "l_names", { map })).toBe("warn");
    // A name it avoids, in the article's own sentence: a fail, with what to change.
    const avoided = SAMPLE_ARTICLE.replace("Use it when buyers research vendors", "Use this GEO tool when buyers research vendors");
    const r = evaluateCitable(avoided, { brief: SAMPLE_BRIEF, map });
    const item = r.items.find((it) => it.id === "l_names")!;
    expect(item.status).toBe("fail");
    expect(item.detail).toBe("Uses names your brand map avoids: “GEO tool” (say “AI search visibility monitoring”).");
    expect(citableGaps(r)).toContain(
      "In your own sentences, replace “GEO tool” with “AI search visibility monitoring”. Leave a buyer's question in a heading, a quotation and a source's title as they are.",
    );
  });

  it("asks where the brand doesn't fit only when the map says what it is not, and only ever warns", () => {
    const map = mapWith({ isNot: ["A general SEO suite"] });
    // The sample has a "What are its limits?" section; without it, nothing says where it doesn't fit.
    expect(statusOf(SAMPLE_ARTICLE, "i_limits", { map })).toBe("pass");
    const unlimited = SAMPLE_ARTICLE.replace(/## What are its limits\?[\s\S]*?(?=## Frequently asked questions)/, "");
    expect(statusOf(unlimited, "i_limits", { map })).toBe("warn");
    const headed = unlimited.replace("## Frequently asked questions", "## When is Acme not the right fit?\n\nAcme is not a general SEO suite.\n\n## Frequently asked questions");
    expect(statusOf(headed, "i_limits", { map })).toBe("pass");
    // Saying what the map says it is not counts too.
    expect(statusOf(unlimited.replace("Use it when buyers", "Acme is not a general SEO suite. Use it when buyers"), "i_limits", { map })).toBe("pass");
    const r = evaluateCitable(unlimited, { brief: SAMPLE_BRIEF, map });
    expect(r.items.find((it) => it.id === "i_limits")!.status).not.toBe("fail");
    expect(ids(SAMPLE_ARTICLE, mapWith({}))).not.toContain("i_limits");
  });
});
