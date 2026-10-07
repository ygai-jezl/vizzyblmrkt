import { BlogBriefSchema, type BlogBrief } from "@/lib/types/contentPlan";

/**
 * A blog article that meets the CITABLE structure, and the brief it was written from —
 * shared by the blog tests. The brand, its pages and its numbers are made up.
 */

const para = (words: number, seed: string) =>
  Array.from({ length: words }, (_, i) => `${seed}${i % 7}`).join(" ") + ".";

/** A section body: a 45-word answer, then enough evidence to reach ~230 words. */
function section(question: string, extra = ""): string {
  return [`## ${question}`, "", para(45, "answer"), "", para(120, "evidence"), "", extra || para(60, "detail"), ""].join("\n");
}

export const SAMPLE_BRIEF: BlogBrief = BlogBriefSchema.parse({
  primaryQuestion: "What is AI search visibility monitoring?",
  questions: [
    { question: "How does it differ from SEO rank tracking?", intent: "comparison", by: "research" },
    { question: "What does it cost?", intent: "pricing", by: "research" },
  ],
  links: [
    { url: "https://acme.example/pricing", label: "Pricing", intent: "convert", by: "research" },
    { url: "https://acme.example/product", label: "Product overview", intent: "product", by: "research" },
    { url: "https://acme.example/customers/harbor", label: "Customer story: Harbor", intent: "proof", by: "research" },
  ],
  sources: [
    {
      url: "https://research.example.org/buyers-2026",
      title: "How buyers research software",
      publisher: "Example Research",
      year: 2026,
      fact: "A 2026 survey of 1,076 decision makers found 51% begin software research with an AI chatbot.",
      status: "verified",
    },
    {
      url: "https://press.example.net/ai-search-converts",
      title: "AI search converts",
      publisher: "press.example.net",
      year: null,
      fact: "AI search traffic converts at 14.2% compared with 2.8% for organic search.",
      status: "operator",
    },
    {
      url: "https://blocked.example.io/report",
      title: "",
      publisher: "blocked.example.io",
      year: null,
      fact: "By 2028, 50% of search volume will move to AI.",
      status: "unverified",
    },
  ],
  entities: [
    { name: "Acme Visibility", relation: "product", by: "research" },
    { name: "AI search visibility monitoring", relation: "category", by: "research" },
    { name: "Rivalco", relation: "alternative", by: "research" },
    { name: "ExampleChat", relation: "integration", by: "research" },
  ],
  publisherName: "Acme",
  publisherUrl: "https://acme.example",
  researchedAt: "2026-10-07T09:00:00.000Z",
});

export const SAMPLE_ARTICLE = [
  "# What is AI search visibility monitoring?",
  "",
  "*Last updated: 2026-10-07*",
  "",
  "AI search visibility monitoring is the practice of measuring how often AI answer engines name a brand. Acme Visibility is an AI search visibility monitoring platform built for B2B marketing teams. Use it when buyers research vendors in an AI assistant.",
  "",
  "> **Key facts**",
  "> - 51% of decision makers begin software research with an AI chatbot [Example Research, 2026](https://research.example.org/buyers-2026).",
  "> - AI search traffic converts at 14.2% [press.example.net](https://press.example.net/ai-search-converts).",
  "> - Harbor's share of voice rose from 6% to 21% [Customer story](https://acme.example/customers/harbor).",
  "",
  "> **TL;DR**",
  "> - Monitor the prompts buyers ask.",
  "> - Measure share of voice, not positions.",
  "> - Close citation gaps first.",
  "",
  section(
    "How does it differ from SEO rank tracking?",
    [
      "| Approach | Measures |",
      "| --- | --- |",
      "| Rank tracking | A position on a results page |",
      "| Visibility monitoring | Whether an answer names the brand |",
      "",
      "- It samples each prompt more than once.",
      "- It keeps the answer's citations.",
      "",
      "Acme Visibility is an alternative to Rivalco. See the [product overview](https://acme.example/product).",
    ].join("\n"),
  ),
  section("What does it cost?"),
  section("Which answer engines does it cover?"),
  section("How do teams use a citation gap report?"),
  section("What are its limits?"),
  "## Frequently asked questions",
  "",
  "### Is it accurate?",
  "",
  para(45, "faq"),
  "",
  "### Who is it for?",
  "",
  para(50, "faq"),
  "",
  "### Can the data be exported?",
  "",
  para(42, "faq"),
  "",
  "## Next step",
  "",
  "See the plans on the [pricing page](https://acme.example/pricing).",
  "",
  "## Sources",
  "",
  "1. [How buyers research software](https://research.example.org/buyers-2026) — Example Research, 2026",
  "2. [AI search converts](https://press.example.net/ai-search-converts) — press.example.net",
  "",
].join("\n");
