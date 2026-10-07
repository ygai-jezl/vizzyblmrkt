import type { BlogArticleMeta, BlogBrief } from "@/lib/types/contentPlan";
import { articleFigures } from "./figures";
import { countWords, plainInline, inlineLinks } from "./markdown";
import { outlineArticle, type ArticleOutline } from "./outline";
import { EMPTY_BLOG_BRIEF, hostOf, normalizeUrl, ownHosts, usableSources } from "./brief";

/**
 * The CITABLE check — a blog article read against the seven things that make a page
 * easy for an answer engine to retrieve, quote and cite:
 *
 *   C  Clear entity & structure      I  Intent architecture
 *   T  Third-party validation        A  Answer grounding
 *   B  Block-structured for RAG      L  Latest & consistent
 *   E  Entity graph & schema
 *
 * Every item is read off the article itself (and the brief it was written from), so the
 * same check runs on the server after writing and live in the inspector while a person
 * edits. It checks structure and traceability — whether the article is TRUE is still a
 * person's call, which is why unsupported figures are listed rather than hidden.
 * Pure + client-safe.
 */

export type CitableLetter = "C" | "I" | "T" | "A" | "B" | "L" | "E";
export type CitableStatus = "pass" | "warn" | "fail";

export interface CitableItem {
  id: string;
  letter: CitableLetter;
  label: string;
  status: CitableStatus;
  /** What was found, in plain words. */
  detail: string;
  /** For a writer's second pass: what to change. "" when nothing can be fixed by rewriting. */
  fix: string;
}

export interface CitableReport {
  /** 0-100: a pass is a full point, a warning half. */
  score: number;
  items: CitableItem[];
  outline: ArticleOutline;
  /** The untraceable figures that are still in the copy (one a person has since edited
   *  out is no longer reported). */
  figuresToCheck: string[];
}

export const CITABLE_LETTERS: { letter: CitableLetter; name: string }[] = [
  { letter: "C", name: "Clear entity & structure" },
  { letter: "I", name: "Intent architecture" },
  { letter: "T", name: "Third-party validation" },
  { letter: "A", name: "Answer grounding" },
  { letter: "B", name: "Block-structured for RAG" },
  { letter: "L", name: "Latest & consistent" },
  { letter: "E", name: "Entity graph & schema" },
];

const QUESTION_START =
  /^(how|what|why|which|when|where|who|whose|can|could|does|do|did|is|are|was|were|should|will|would|has|have)\b/i;
const RELATION_PHRASE =
  /\b(alternatives? to|integrates? with|works? with|connects? to|used by|built for|designed for|compared (?:to|with)|versus|vs\.?|is an?\b|are an?\b)/i;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface CitableContext {
  brief?: BlogBrief | null;
  meta?: BlogArticleMeta | null;
  /** The article's own URL (the plan's hub URL), when known. */
  pageUrl?: string | null;
}

export function evaluateCitable(markdown: string, context: CitableContext = {}): CitableReport {
  const brief = context.brief ?? EMPTY_BLOG_BRIEF;
  const o = outlineArticle(markdown);
  const items: CitableItem[] = [];
  const add = (
    id: string,
    letter: CitableLetter,
    label: string,
    status: CitableStatus,
    detail: string,
    fix = "",
  ) => items.push({ id, letter, label, status, detail, fix: status === "pass" ? "" : fix });

  // Which links go where: the brand's own pages, a cited third party, or neither.
  const own = ownHosts(brief, [context.pageUrl]);
  const sourceHosts = new Set(usableSources(brief).map((s) => hostOf(s.url)));
  const convert = new Set(brief.links.filter((l) => l.intent === "convert").map((l) => normalizeUrl(l.url)));
  const hrefs = [...new Set(o.links.map((l) => normalizeUrl(l.href)).filter(Boolean))];
  const internal = hrefs.filter((h) => own.has(hostOf(h)));
  const thirdParty = hrefs.filter((h) => !own.has(hostOf(h)));
  const thirdPartyHosts = new Set(thirdParty.map(hostOf));

  // ── C — Clear entity & structure ──
  const blufWords = countWords(o.bluf);
  add(
    "c_bluf",
    "C",
    "Opens with the answer",
    !o.title || blufWords === 0 || blufWords > 200 ? "fail" : blufWords <= 110 ? "pass" : "warn",
    !o.title
      ? "No H1 title."
      : blufWords === 0
        ? "No opening answer under the title."
        : `${plural(blufWords, "word")} before the first section (aim for 100 or fewer).`,
    "Open with a 2-3 sentence answer of at most 90 words, straight under the H1: what it is, who it is for, when to use it.",
  );
  const facts = o.keyFacts ?? [];
  const factsWithNumber = facts.filter((f) => /\d/.test(plainInline(f))).length;
  const factsWithLink = facts.filter((f) => inlineLinks(f).length > 0).length;
  add(
    "c_key_facts",
    "C",
    "Key facts box",
    !o.keyFacts
      ? "fail"
      : facts.length >= 3 && facts.length <= 5 && factsWithNumber === facts.length && factsWithLink === facts.length
        ? "pass"
        : "warn",
    !o.keyFacts
      ? "No Key facts box."
      : `${plural(facts.length, "fact")}: ${factsWithNumber} with a number or date, ${factsWithLink} linked to a source (aim for 3-5, all of them both).`,
    "Add a Key facts box under the opening answer: > **Key facts** then 3-5 bullets, each one number or date from the material given, each ending with its source link when the material gives one.",
  );
  add(
    "c_hierarchy",
    "C",
    "Tidy heading order",
    o.hierarchyIssues.length === 0 ? "pass" : o.h1Count === 1 ? "warn" : "fail",
    o.hierarchyIssues.length === 0 ? "One H1, then H2 and H3 in order." : `Found ${o.hierarchyIssues.join("; ")}.`,
    "Use exactly one # H1, ## for each section and ### only inside a section.",
  );

  // ── I — Intent architecture ──
  add(
    "i_question",
    "I",
    "Title is the buyer's question",
    !o.title ? "fail" : /\?\s*$/.test(o.title) || QUESTION_START.test(o.title) ? "pass" : "warn",
    !o.title ? "No H1 title." : `“${o.title.slice(0, 90)}”`,
    "Word the H1 as the question the buyer asks.",
  );
  const n = o.sections.length;
  add(
    "i_intents",
    "I",
    "Covers the questions asked next",
    n >= 5 && n <= 7 ? "pass" : n >= 3 && n <= 9 ? "warn" : "fail",
    `${plural(n, "question section")} (aim for 5-7: alternatives, integrations, use cases, pricing, limits, benchmarks).`,
    "Give the article 5-7 ## sections, each headed by a question a buyer asks next.",
  );
  const convertUsed = internal.filter((h) => convert.has(h)).length;
  if (brief.links.length === 0) {
    add(
      "i_links",
      "I",
      "Links to your own pages",
      "warn",
      "The brief lists no pages to link to — add your pricing, demo or sign-up page and regenerate.",
    );
  } else {
    add(
      "i_links",
      "I",
      "Links to your own pages",
      internal.length >= 2 && (convert.size === 0 || convertUsed > 0) ? "pass" : internal.length >= 1 ? "warn" : "fail",
      `${plural(internal.length, "internal link")}` +
        (convert.size ? `, ${convertUsed} to a conversion page.` : " (the brief has no conversion page).") ,
      "Link 2-4 of the allowed pages where they help the reader go deeper, and end the Next step section with the conversion page.",
    );
  }

  // ── T — Third-party validation ──
  if (sourceHosts.size === 0) {
    add(
      "t_third_party",
      "T",
      "Backed by third parties",
      "warn",
      "The brief has no checked third-party sources — add or confirm some, then regenerate.",
    );
  } else {
    add(
      "t_third_party",
      "T",
      "Backed by third parties",
      thirdPartyHosts.size >= 2 ? "pass" : thirdPartyHosts.size === 1 ? "warn" : "fail",
      `Cites ${plural(thirdPartyHosts.size, "third-party site")} (aim for 2 or more).`,
      "Cite at least two of the allowed third-party sources inline, where their fact supports the point.",
    );
  }

  // ── A — Answer grounding ──
  const direct = o.sections.filter((s) => {
    const w = countWords(s.lead);
    return w >= 25 && w <= 80;
  }).length;
  add(
    "a_direct",
    "A",
    "Each section answers first",
    n === 0 ? "fail" : direct === n ? "pass" : direct >= Math.ceil(n * 0.6) ? "warn" : "fail",
    n === 0 ? "No sections." : `${direct} of ${n} sections open with a 40-60 word answer.`,
    "Open every ## section with a 40-60 word answer that makes sense on its own, then expand.",
  );
  add(
    "a_citations",
    "A",
    "Claims carry their source",
    hrefs.length >= 3 ? "pass" : hrefs.length >= 1 ? "warn" : "fail",
    `${plural(hrefs.length, "distinct link")} to sources and pages (aim for 3 or more).`,
    "Put the source link next to each fact you state from the material given.",
  );
  // The server found these when it last wrote or checked the copy; one the operator has
  // since taken out of the copy is no longer a problem.
  const inCopy = new Set(articleFigures(markdown).map((f) => f.display));
  const unsupported = (context.meta?.unsupportedFigures ?? []).filter((f) => inCopy.has(f));
  add(
    "a_figures",
    "A",
    "Every figure is traceable",
    unsupported.length === 0 ? "pass" : "fail",
    unsupported.length === 0
      ? "Every figure was found in what the writer was given."
      : `Not found in your knowledge or sources — check or remove: ${unsupported.slice(0, 8).join(", ")}.`,
    `These figures are not in the material given: ${unsupported.slice(0, 12).join(", ")}. Remove each one, or replace it with a figure from the material (keep a number that is only part of a product or version name).`,
  );
  add(
    "a_sources",
    "A",
    "Lists its sources",
    o.sources?.length ? "pass" : thirdParty.length === 0 ? "pass" : "warn",
    o.sources?.length
      ? plural(o.sources.length, "source") + " listed."
      : thirdParty.length === 0
        ? "Cites no third-party page, so there is nothing to list."
        : "Cites third-party pages but has no Sources section.",
    "End with a ## Sources section: a numbered list of every third-party source cited, as [Title](URL) — publisher, year.",
  );

  // ── B — Block-structured for RAG ──
  const tldr = o.tldr ?? [];
  add(
    "b_tldr",
    "B",
    "TL;DR box",
    !o.tldr ? "fail" : tldr.length >= 3 && tldr.length <= 5 ? "pass" : "warn",
    !o.tldr ? "No TL;DR box." : `${plural(tldr.length, "takeaway")} (aim for 3-5).`,
    "Add a TL;DR box after the Key facts: > **TL;DR** then 3-5 one-line takeaways.",
  );
  const sized = o.sections.filter((s) => s.words >= 150 && s.words <= 420).length;
  add(
    "b_blocks",
    "B",
    "Sections stand alone",
    n === 0 ? "fail" : sized === n ? "pass" : sized >= Math.ceil(n * 0.6) ? "warn" : "fail",
    n === 0
      ? "No sections."
      : `${sized} of ${n} sections are 200-400 words` +
        (sized === n ? "." : ` (others: ${o.sections.filter((s) => s.words < 150 || s.words > 420).map((s) => s.words).join(", ")} words).`),
    "Keep every ## section between 200 and 350 words, readable without the rest of the article.",
  );
  const tables = o.tableRows.length;
  const longTable = o.tableRows.some((r) => r > 10);
  add(
    "b_table_list",
    "B",
    "A table and a list",
    tables >= 1 && o.bodyLists >= 1 && !longTable ? "pass" : tables >= 1 || o.bodyLists >= 1 ? "warn" : "fail",
    `${plural(tables, "table")}${longTable ? " (one is over 10 rows)" : ""}, ${plural(o.bodyLists, "list")} in the body.`,
    "Include at least one Markdown pipe table (2-4 columns, at most 8 rows) comparing options, and at least one bulleted list.",
  );
  const faqSized = o.faq.filter((f) => {
    const w = countWords(f.answer);
    return w >= 25 && w <= 110;
  }).length;
  add(
    "b_faq",
    "B",
    "FAQ",
    o.faq.length >= 3 && o.faq.length <= 5 && faqSized === o.faq.length
      ? "pass"
      : o.faq.length >= 1
        ? "warn"
        : "fail",
    o.faq.length === 0
      ? "No FAQ section."
      : `${plural(o.faq.length, "question")}, ${faqSized} with a self-contained 40-70 word answer (aim for 3-5).`,
    "Add ## Frequently asked questions with 3-5 ### questions, each answered in 40-70 words that make sense alone.",
  );
  add(
    "b_length",
    "B",
    "Right length",
    o.words >= 1000 && o.words <= 2500 ? "pass" : o.words >= 600 && o.words <= 3000 ? "warn" : "fail",
    `${plural(o.words, "word")} (1,500-2,500 suits a full topic; 1,000 a narrow one).`,
    o.words < 1000
      ? "Expand the sections with evidence from the material given, to 1,300-1,900 words in total."
      : "Tighten the article to 1,300-1,900 words in total.",
  );

  // ── L — Latest & consistent ──
  add(
    "l_updated",
    "L",
    "Shows when it was last updated",
    o.lastUpdated ? "pass" : "fail",
    o.lastUpdated ? `Last updated ${o.lastUpdated}.` : "No “Last updated: YYYY-MM-DD” line under the title.",
  );

  // ── E — Entity graph & schema ──
  const lower = o.plain.toLowerCase();
  const named = brief.entities.filter((e) => lower.includes(e.name.toLowerCase()));
  if (brief.entities.length === 0) {
    add(
      "e_entities",
      "E",
      "States how things relate",
      RELATION_PHRASE.test(o.bluf) ? "pass" : "warn",
      "The brief lists no entities; the opening " +
        (RELATION_PHRASE.test(o.bluf) ? "says what the subject is." : "does not say plainly what the subject is."),
      "In the opening answer, say plainly what the subject is and which category it belongs to.",
    );
  } else {
    add(
      "e_entities",
      "E",
      "States how things relate",
      named.length >= Math.ceil(brief.entities.length / 2) && RELATION_PHRASE.test(o.plain)
        ? "pass"
        : "warn",
      `Names ${named.length} of ${brief.entities.length} entities from the brief.`,
      "Name the entities listed and state each relationship in a plain sentence, but only where the material supports it.",
    );
  }
  add(
    "e_schema",
    "E",
    "Ready for schema markup",
    o.title && o.lastUpdated && o.faq.length >= 2 ? "pass" : o.title ? "warn" : "fail",
    o.title && o.lastUpdated && o.faq.length >= 2
      ? `BlogPosting + FAQPage (${plural(o.faq.length, "question")}) can mirror what is on the page.`
      : "Markup needs a title, a Last updated date and an FAQ to mirror.",
  );

  const points = items.reduce((sum, it) => sum + (it.status === "pass" ? 1 : it.status === "warn" ? 0.5 : 0), 0);
  return { score: Math.round((points / items.length) * 100), items, outline: o, figuresToCheck: unsupported };
}

/**
 * What a second writing pass should change. Only a FAILED item is worth a rewrite; once
 * one is, the warnings ride along (the article is being rewritten anyway). Empty = leave
 * the draft as it is. Capped so the instruction stays short.
 */
export function citableGaps(report: CitableReport, max = 8): string[] {
  if (!report.items.some((it) => it.status === "fail" && it.fix)) return [];
  const order: CitableStatus[] = ["fail", "warn"];
  return order
    .flatMap((status) => report.items.filter((it) => it.status === status && it.fix))
    .slice(0, max)
    .map((it) => it.fix);
}
