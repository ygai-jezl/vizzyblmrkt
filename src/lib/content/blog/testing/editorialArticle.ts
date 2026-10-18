import { BlogBriefSchema, type BlogBrief } from "@/lib/types/contentPlan";
import { SAMPLE_BRIEF } from "./sampleArticle";

/**
 * An article written to the editorial shape (CREATE_BLOG_EDITORIAL_ENABLED), and the brief it
 * was written from: SAMPLE_BRIEF with a named author. Shared by the blog tests. The brand, the
 * author, its pages and its numbers are made up.
 */

export const EDITORIAL_BRIEF: BlogBrief = BlogBriefSchema.parse({
  ...SAMPLE_BRIEF,
  primaryQuestion: "How often should you check your AI search visibility?",
  author: "Ana Ruiz",
  authorRole: "Head of Growth",
  authorBio: "Ana has run growth at two software companies and now leads it at Acme.",
  authorUrl: "https://acme.example/team/ana",
});

const BANK = [
  "A team that reads every answer learns which pages the assistants lean on.",
  "The cost of a check is the hour someone spends reading it, not the run itself.",
  "One odd answer is a data point, and a week of them is a pattern.",
  "Buyers ask in their own words, so the questions worth tracking rarely contain a brand name.",
  "When an answer changes, the page that moved it is usually somebody else's.",
  "Reading the cited pages tells you more than counting how often you were named.",
  "A short list of real buying questions beats a long list nobody opens.",
];

/** Plain prose of about `words` words, from the bank above. */
function prose(words: number, start = 0): string {
  const out: string[] = [];
  let n = 0;
  for (let i = start; n < words; i += 1) {
    const s = BANK[i % BANK.length]!;
    out.push(s);
    n += s.split(/\s+/).length;
  }
  return out.join(" ");
}

function section(heading: string, answer: string, extra = "", words = 170): string {
  return [`## ${heading}`, "", `${answer} ${prose(words / 2)}`, "", extra || prose(words / 2, 3), ""].join("\n");
}

export const EDITORIAL_ARTICLE = [
  "# How often should you check your AI search visibility?",
  "",
  "*Last updated: 2026-10-07 · By Ana Ruiz, Head of Growth*",
  "",
  "For most teams a weekly check is enough to see a trend without chasing noise. How often you need depends on how fast your category moves, and on whether anyone will act on what changes.",
  "",
  "Answers from AI assistants shift from day to day even when nobody publishes anything. A daily check mostly records that shift; a weekly one shows which way it is going.",
  "",
  "**Key takeaways**",
  "",
  "- A weekly check shows the trend, and a daily one mostly shows noise.",
  "- The questions without your name in them matter most.",
  "- A check nobody reads is a cost, not a habit.",
  "",
  section(
    "Why do answers change when nothing was published?",
    "Answers change because the assistants pick their sources afresh each time, so the same question can name different companies on different days.",
    `${prose(60, 2)} A 2026 survey found 51% of decision makers begin software research with an AI chatbot ([Example Research, 2026](https://research.example.org/buyers-2026)).`,
  ),
  section(
    "How often should most teams check?",
    "Most teams should check weekly, and read the answers rather than only count them.",
  ),
  section(
    "When is a daily check worth it?",
    "A daily check is worth it during a launch, or while a competitor is publishing pages about you.",
    `${prose(70, 1)} Acme Visibility runs the same questions on a schedule, so the week's answers sit side by side ([Product overview](https://acme.example/product)).`,
  ),
  section(
    "Common mistakes",
    "The most common mistake is tracking only questions that already contain your name.",
  ),
  "## The bottom line",
  "",
  `Check weekly, read what changed and act on it, or do not check at all. ${prose(30, 4)} [See what a weekly check costs](https://acme.example/pricing).`,
  "",
  "## Frequently asked questions",
  "",
  "### Does checking more often improve visibility?",
  "",
  `No. Checking only tells you where you stand; what changes the answers is the pages the assistants read. ${prose(40, 5)}`,
  "",
  "### Which questions should we track first?",
  "",
  `Start with the questions a buyer asks before they know your name, worded the way they would type them. ${prose(40, 6)}`,
  "",
  "### What should we do when an answer changes?",
  "",
  `Open the pages the answer cites and see which of them is new or changed. ${prose(45, 0)}`,
  "",
  "## Sources",
  "",
  "1. [How buyers research software](https://research.example.org/buyers-2026), Example Research, 2026",
  "",
  "## About the author",
  "",
  "**Ana Ruiz**, Head of Growth",
  "",
  "Ana has run growth at two software companies and now leads it at Acme.",
].join("\n");
