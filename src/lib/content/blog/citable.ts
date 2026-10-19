import type { BlogArticleMeta, BlogBrief } from "@/lib/types/contentPlan";
import { articleFigures } from "./figures";
import { blockPlain, countWords, inlineLinks, parseArticle, plainInline } from "./markdown";
import { outlineArticle, type ArticleOutline } from "./outline";
import { EMPTY_BLOG_BRIEF, hostOf, normalizeUrl, ownHosts, usableSources } from "./brief";
import type { ArticleMap } from "./articleMap";
import { avoidedUses, countName, mentionsName } from "./names";
import { aiTellsIn } from "@/lib/content/writingRules";
import { focusedBrief, isChoosingQuestion, isSloganLabel } from "./focus";
import { hasAsciiTable } from "./asciiTables";
import { fold } from "@/lib/brandMap/changes";

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

export type CitableLetter = "C" | "I" | "T" | "A" | "B" | "L" | "E" | "V";
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
  // Editorial articles only (meta.style "editorial"): how it reads.
  { letter: "V", name: "Voice" },
];

const QUESTION_START =
  /^(how|what|why|which|when|where|who|whose|can|could|does|do|did|is|are|was|were|should|will|would|has|have)\b/i;
const RELATION_PHRASE =
  /\b(alternatives? to|integrates? with|works? with|connects? to|used by|built for|designed for|compared (?:to|with)|versus|vs\.?|is an?\b|are an?\b)/i;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A heading or question about where something does not fit, in plain English. */
const LIMITS_QUESTION =
  /\b(limits?|limitations?|drawbacks?|downsides?|trade-?offs?|not (?:the )?right fit|not a (?:good )?fit|isn['’]t for|is not for|when not to|doesn['’]t (?:fit|work)|does not (?:fit|work)|won['’]t work|who (?:it|this) is(?:n['’]t| not) for)\b/i;

export interface CitableContext {
  brief?: BlogBrief | null;
  meta?: BlogArticleMeta | null;
  /** The article's own URL (the plan's hub URL), when known. */
  pageUrl?: string | null;
  /** The brand map it is written from (CREATE_BLOG_BRAND_MAP_ENABLED). Without one, the
   *  checklist is exactly as before; with one it gains "Says where it doesn't fit" (when
   *  the map lists what the brand is not) and "Keeps to your names". */
  map?: ArticleMap | null;
  /** Add the hero image item (BLOG_HERO_ENABLED; the inspector only). A warning at most,
   *  never a rewrite, and outside the score, which is about the copy. */
  heroCheck?: boolean;
}

/**
 * Map text as the checklist says it. Its fix lines become the writer's revision instructions,
 * outside any fence, so a name from the map is said plainly and can carry nothing else.
 */
const said = (s: string) => s.replace(/\s+/g, " ").replace(/[<>"“”]/g, "").trim().slice(0, 120);

// ── Voice: how an editorial article reads ──

/** A claim of the brand's own first-hand experience. */
const EXPERIENCE =
  /\b(we(?:['’]ve| have)? (?:seen|watched|found|tested|noticed|learned|learnt)|we (?:work|worked) with|in our (?:work|tests?|experience|data|own)|our (?:clients|customers)|a (?:client|customer) of ours|brands? we (?:track|work with))\b/i;
/** A section about where it goes wrong. */
const WRONG =
  /\b(mistakes?|pitfalls?|go(?:es)? wrong|trade-?offs?|when not to|downsides?|limits?|limitations?|what to avoid|risks?|myths?)\b/i;
/** A title that is about choosing a product, and a heading that is. */
const CHOOSING_HEADING = /\b(alternatives?|competitors?|vs\.?|versus|top \d+|best (?:\w+ )?(?:tools?|platforms?|software|apps?))\b/i;
/** A box the editorial shape leaves out. */
const BOX_LABEL = /^(key\s+(facts|numbers|stats)|tl\s*;?\s*dr|(the\s+)?(direct|quick|short)\s+answer|answer|in\s+short)\b/i;

function firstSentence(text: string): string {
  return /^(.+?[.!?])(?:\s|$)/.exec(text.trim())?.[1] ?? text.trim();
}

/** The experience an article may claim: its matched notes and what a person wrote for it. */
export function seenNotes(brief: BlogBrief): string[] {
  const seen = brief.seen;
  if (!seen) return [];
  return [...seen.notes.map((n) => n.text), ...(seen.own.trim() ? [seen.own.trim()] : [])];
}

function voiceItems(markdown: string, o: ArticleOutline, brief: BlogBrief, map: ArticleMap | null): CitableItem[] {
  const out: CitableItem[] = [];
  const add = (id: string, label: string, status: CitableStatus, detail: string, fix = "") =>
    out.push({ id, letter: "V", label, status, detail, fix: status === "pass" ? "" : fix });

  const notes = seenNotes(brief);
  const claims = [...new Set([...o.plain.matchAll(new RegExp(EXPERIENCE.source, "gi"))].map((m) => m[0].toLowerCase()))];
  if (notes.length) {
    add(
      "v_experience",
      "Speaks from experience",
      claims.length ? "pass" : "warn",
      claims.length ? `Uses what your team has seen (${plural(notes.length, "note")}).` : `${plural(notes.length, "note")} from your team, not used yet.`,
      "Work the brand's notes into the sections where they bear most, in the first person plural, keeping every specific and adding none.",
    );
  } else {
    add(
      "v_experience",
      "Speaks from experience",
      claims.length ? "fail" : "warn",
      claims.length
        ? `Claims experience no note backs: ${claims.slice(0, 4).map((c) => `“${c}”`).join(", ")}.`
        : "Written as analysis. Add what your team has seen to speak from experience.",
      claims.length ? "Take out every claim of first-hand experience (“we have seen”, “our clients”): the brand gave no notes for this article." : "",
    );
  }

  const brand = (map?.identity.name || brief.publisherName).replace(/\s+/g, " ").trim();
  if (brand) {
    const inOpening = countName(o.bluf, brand) > 0;
    const body = [
      ...o.sections.flatMap((sec) => sec.blocks.map(blockPlain)),
      ...(o.nextStep ?? []).map(blockPlain),
      ...o.faq.map((f) => f.answer),
    ].join("\n");
    const n = countName(body, brand);
    add(
      "v_brand",
      "Brand kept to the margins",
      inOpening || n > 4 ? "fail" : n > 2 ? "warn" : "pass",
      `${said(brand)} is named ${plural(n, "time")} in the body${inOpening ? ", and in the opening" : ""} (aim for 2 at most, none in the opening).`,
      `Leave ${said(brand)} out of the opening paragraphs, and name it at most twice in the body, each time as the tool that measures or does what is discussed.`,
    );
  }

  const tells = aiTellsIn(o.plain);
  add(
    "v_tells",
    "No AI phrases",
    tells.length ? "fail" : "pass",
    tells.length ? `Uses ${tells.slice(0, 8).map((t) => `“${t}”`).join(", ")}.` : "None of the phrases readers take as AI writing.",
    `Rewrite these in plain words: ${tells.slice(0, 12).map((t) => `“${t}”`).join(", ")}.`,
  );

  const boxes = parseArticle(markdown).filter((b) => b.kind === "callout" && BOX_LABEL.test(b.label)).length;
  add(
    "v_boxes",
    "No boxes nobody asked for",
    boxes ? "warn" : "pass",
    boxes
      ? `${plural(boxes, "box", "boxes")} (Key facts, TL;DR or Answer) the editorial shape leaves out. Fine if the brief asked for them.`
      : "Says it in the prose.",
  );

  const wrong = o.sections.some((sec) => WRONG.test(sec.heading) || LIMITS_QUESTION.test(sec.heading));
  add(
    "v_wrong",
    "Says where it goes wrong",
    wrong ? "pass" : "warn",
    wrong ? "Has a section on mistakes, trade-offs or when not to." : "No section on where it goes wrong.",
    "Give one section to where it goes wrong: the common mistakes, the trade-offs, or when not to do it.",
  );

  const offTopic = o.title && !isChoosingQuestion(o.title) ? o.sections.find((sec) => CHOOSING_HEADING.test(sec.heading)) : undefined;
  add(
    "v_focus",
    "Stays on its question",
    offTopic ? "fail" : "pass",
    offTopic ? `“${said(offTopic.heading)}” is about choosing a product, which the title doesn't ask.` : "No section strays into choosing a product.",
    offTopic ? `Take out the section “${said(offTopic.heading)}”: the article's question is not about choosing a product.` : "",
  );
  // The same sentence said of several things is filler ("X: An alternative in the category." four times).
  const counts = new Map<string, number>();
  for (const block of parseArticle(markdown)) {
    if (block.kind !== "list") continue;
    for (const item of block.items) {
      const rest = plainInline(item).replace(/^[^:]{1,60}:\s+/, "").toLowerCase().replace(/\s+/g, " ").trim();
      if (rest.length >= 20) counts.set(rest, (counts.get(rest) ?? 0) + 1);
    }
  }
  const filler = [...counts].find(([, n]) => n >= 3)?.[0];
  add(
    "v_repeat",
    "No repeated filler",
    filler ? "fail" : "pass",
    filler ? `A list says the same thing about several items: “${said(filler).slice(0, 80)}”.` : "No list repeats itself.",
    filler ? `Take out the list where every item says “${said(filler).slice(0, 80)}”, or say something different and true about each item.` : "",
  );

  // A table drawn out of characters (+----+) instead of a Markdown table.
  const drawn = hasAsciiTable(markdown);
  add(
    "v_tables",
    "Tables are real tables",
    drawn ? "fail" : "pass",
    drawn ? "Has a table drawn out of characters." : "No tables drawn out of characters.",
    "Turn every table drawn out of characters (+, -, |) into a Markdown pipe table, or into plain prose.",
  );

  // A page's slogan copied in as link text ("Speak Fluent ChatGPT. No Code Required.").
  const slogans = new Map(brief.links.filter((l) => isSloganLabel(l.label)).map((l) => [normalizeUrl(l.url), l.label.trim().toLowerCase()]));
  const copied = o.links.find((l) => slogans.get(normalizeUrl(l.href)) === l.text.trim().toLowerCase());
  add(
    "v_anchor",
    "Link text says where it goes",
    copied ? "fail" : "pass",
    copied ? `Links with the page's slogan as its text: “${said(copied.text).slice(0, 80)}”.` : "No link uses a page's slogan as its text.",
    copied ? `Rewrite the link text “${said(copied.text).slice(0, 80)}” to say what the reader gets there, in a few plain words.` : "",
  );
  return out;
}

export function evaluateCitable(markdown: string, context: CitableContext = {}): CitableReport {
  const o = outlineArticle(markdown);
  const items: CitableItem[] = [];
  // An editorial article (CREATE_BLOG_EDITORIAL_ENABLED) is read against its own shape: no
  // Key facts or TL;DR box, no table required, sections that open by answering, and how it
  // reads (the Voice items). The article says which shape it was written in, and is read
  // against the brief its writer was given (no alternatives it wasn't asked about).
  const editorial = context.meta?.style === "editorial";
  const given = context.brief ?? EMPTY_BLOG_BRIEF;
  const brief = editorial ? focusedBrief(given, o.title ?? given.primaryQuestion) : given;
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
  if (editorial) {
    add(
      "c_bluf",
      "C",
      "Opens with the answer",
      !o.title || blufWords === 0 || blufWords > 220 ? "fail" : blufWords <= 140 ? "pass" : "warn",
      !o.title
        ? "No H1 title."
        : blufWords === 0
          ? "No opening under the title."
          : `${plural(blufWords, "word")} before the first section (aim for two short paragraphs, 140 words or fewer).`,
      "Open with two short paragraphs straight under the H1: the first answers the title in its first sentence and says what the answer depends on, the second gives the reasoning or the exception that matters most.",
    );
  } else add(
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
  if (!editorial) add(
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
  if (editorial) {
    add(
      "i_intents",
      "I",
      "Covers what a reader asks next",
      n >= 4 && n <= 6 ? "pass" : n >= 3 && n <= 8 ? "warn" : "fail",
      `${plural(n, "section")} (aim for 4-6, each on a question a reader asks next).`,
      "Give the article 4 to 6 ## sections, each on a question a reader of the title asks next.",
    );
  } else add(
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
    const enough = editorial ? internal.length >= 1 : internal.length >= 2;
    add(
      "i_links",
      "I",
      "Links to your own pages",
      enough && (convert.size === 0 || convertUsed > 0) ? "pass" : internal.length >= 1 ? "warn" : editorial ? "warn" : "fail",
      `${plural(internal.length, "internal link")}` +
        (convert.size ? `, ${convertUsed} to a conversion page.` : " (the brief has no conversion page).") ,
      editorial
        ? "Link 1 to 3 of the allowed pages where they help the reader go deeper, and end the bottom line with the conversion page."
        : "Link 2-4 of the allowed pages where they help the reader go deeper, and end the Next step section with the conversion page.",
    );
  }

  // With a brand map that lists what the brand is not: one section or FAQ answer says where
  // it is not the right fit. Only ever a warning: the writer adds no limit of its own.
  const map = context.map ?? null;
  const brand = map?.identity.name ? said(map.identity.name) : brief.publisherName || "the brand";
  if (map && map.identity.isNot.length) {
    const headed = o.sections.some((sec) => LIMITS_QUESTION.test(sec.heading)) || o.faq.some((f) => LIMITS_QUESTION.test(f.question));
    const says = !headed && map.identity.isNot.some((t) => fold(o.plain).includes(fold(t)));
    add(
      "i_limits",
      "I",
      "Says where it doesn't fit",
      headed || says ? "pass" : "warn",
      headed
        ? "Has a section on where it is not the right fit."
        : says
          ? "Says what your brand map says it is not."
          : "Nothing says where it is not the right fit, though your brand map lists what it is not.",
      `Give one section, or one FAQ answer, to where ${brand} is not the right fit, using only what the brand map says it is not.`,
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
      // An editorial article cites only what backs its points: none is a warning, never a rewrite.
      thirdPartyHosts.size >= 2 ? "pass" : thirdPartyHosts.size === 1 || editorial ? "warn" : "fail",
      `Cites ${plural(thirdPartyHosts.size, "third-party site")} (aim for 2 or more).`,
      "Cite at least two of the allowed third-party sources inline, where their fact supports the point.",
    );
  }

  // ── A — Answer grounding ──
  const direct = o.sections.filter((s) => {
    const w = countWords(s.lead);
    return w >= 25 && w <= 80;
  }).length;
  if (editorial) {
    // An editorial section opens with prose whose first sentence answers the heading.
    const opens = o.sections.filter((s) => {
      const first = s.blocks.find((b) => b.kind !== "rule");
      if (first?.kind !== "paragraph") return false;
      const sentence = firstSentence(blockPlain(first));
      return countWords(sentence) >= 6 && countWords(sentence) <= 45;
    }).length;
    add(
      "a_direct",
      "A",
      "Each section answers first",
      n === 0 ? "fail" : opens === n ? "pass" : opens >= Math.ceil(n * 0.6) ? "warn" : "fail",
      n === 0 ? "No sections." : `${opens} of ${n} sections open with a sentence that answers their heading.`,
      "Open every ## section with one or two plain sentences that answer its heading outright, before any list or table.",
    );
  } else add(
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
    hrefs.length >= (editorial ? 2 : 3) ? "pass" : hrefs.length >= 1 || editorial ? "warn" : "fail",
    `${plural(hrefs.length, "distinct link")} to sources and pages (aim for ${editorial ? 2 : 3} or more).`,
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
    "End with a ## Sources section: a numbered list of every third-party source cited, as [Title](URL), publisher, year.",
  );

  // ── B — Block-structured for RAG ──
  const tldr = o.tldr ?? [];
  if (!editorial) add(
    "b_tldr",
    "B",
    "TL;DR box",
    !o.tldr ? "fail" : tldr.length >= 3 && tldr.length <= 5 ? "pass" : "warn",
    !o.tldr ? "No TL;DR box." : `${plural(tldr.length, "takeaway")} (aim for 3-5).`,
    "Add a TL;DR box after the Key facts: > **TL;DR** then 3-5 one-line takeaways.",
  );
  const sized = o.sections.filter((s) => s.words >= (editorial ? 120 : 150) && s.words <= 420).length;
  add(
    "b_blocks",
    "B",
    "Sections stand alone",
    n === 0 ? "fail" : sized === n ? "pass" : sized >= Math.ceil(n * 0.6) ? "warn" : "fail",
    n === 0
      ? "No sections."
      : `${sized} of ${n} sections are ${editorial ? "150-350" : "200-400"} words` +
        (sized === n ? "." : ` (others: ${o.sections.filter((s) => s.words < (editorial ? 120 : 150) || s.words > 420).map((s) => s.words).join(", ")} words).`),
    editorial
      ? "Keep every ## section between 150 and 350 words, readable without the rest of the article."
      : "Keep every ## section between 200 and 350 words, readable without the rest of the article.",
  );
  const tables = o.tableRows.length;
  const longTable = o.tableRows.some((r) => r > 10);
  if (!editorial) add(
    "b_table_list",
    "B",
    "A table and a list",
    tables >= 1 && o.bodyLists >= 1 && !longTable ? "pass" : tables >= 1 || o.bodyLists >= 1 ? "warn" : "fail",
    `${plural(tables, "table")}${longTable ? " (one is over 10 rows)" : ""}, ${plural(o.bodyLists, "list")} in the body.`,
    "Include at least one Markdown pipe table (2-4 columns, at most 8 rows) comparing options, and at least one bulleted list.",
  );
  const faqSized = o.faq.filter((f) => {
    const w = countWords(f.answer);
    return w >= 25 && w <= (editorial ? 130 : 110);
  }).length;
  add(
    "b_faq",
    "B",
    "FAQ",
    o.faq.length >= 3 && o.faq.length <= (editorial ? 6 : 5) && faqSized === o.faq.length
      ? "pass"
      : o.faq.length >= 1
        ? "warn"
        : "fail",
    o.faq.length === 0
      ? "No FAQ section."
      : editorial
        ? `${plural(o.faq.length, "question")}, ${faqSized} with a self-contained 40-90 word answer (aim for 3-6).`
        : `${plural(o.faq.length, "question")}, ${faqSized} with a self-contained 40-70 word answer (aim for 3-5).`,
    editorial
      ? "Add ## Frequently asked questions with 3 to 6 ### questions a reader would still have, each answered in 40 to 90 words that make sense alone."
      : "Add ## Frequently asked questions with 3-5 ### questions, each answered in 40-70 words that make sense alone.",
  );
  add(
    "b_length",
    "B",
    "Right length",
    editorial
      ? o.words >= 1100 && o.words <= 2300 ? "pass" : o.words >= 700 && o.words <= 3000 ? "warn" : "fail"
      : o.words >= 1000 && o.words <= 2500 ? "pass" : o.words >= 600 && o.words <= 3000 ? "warn" : "fail",
    editorial ? `${plural(o.words, "word")} (aim for 1,200-2,000).` : `${plural(o.words, "word")} (1,500-2,500 suits a full topic; 1,000 a narrow one).`,
    editorial
      ? o.words < 1100
        ? "Expand the sections with examples and evidence from the material given, to 1,200-2,000 words in total."
        : "Tighten the article to 1,200-2,000 words in total."
      : o.words < 1000
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

  // With a brand map: the article's own sentences use none of the names it avoids, and its
  // opening names the category the way the map does.
  if (map && (map.identity.avoid.length || map.identity.category)) {
    const own = [map.identity.name, map.identity.category, ...map.names.flatMap((n) => [n.name, ...n.aliases])];
    const uses = avoidedUses(markdown, map.identity.avoid, own);
    const category = said(map.identity.category);
    const opens = !category || mentionsName(o.bluf, category);
    add(
      "l_names",
      "L",
      "Keeps to your names",
      uses.length ? "fail" : opens ? "pass" : "warn",
      uses.length
        ? `Uses names your brand map avoids: ${uses.map((u) => `“${said(u.term)}”${u.useInstead ? ` (say “${said(u.useInstead)}”)` : ""}`).join(", ")}.`
        : opens
          ? "Uses none of the names your brand map avoids, and names your category as you do."
          : `The opening does not name your category, “${category}”.`,
      uses.length
        ? `${uses
            .map((u) =>
              u.useInstead ? `In your own sentences, replace “${said(u.term)}” with “${said(u.useInstead)}”.` : `In your own sentences, stop using “${said(u.term)}”.`,
            )
            .join(" ")} Leave a buyer's question in a heading, a quotation and a source's title as they are.`
        : `In the opening answer, name the category exactly as “${category}”.`,
    );
  }

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

  if (editorial) items.push(...voiceItems(markdown, o, brief, map));

  if (context.heroCheck) {
    const h = context.meta?.hero;
    const has = Boolean(h?.heroRef && h?.shareRef);
    add(
      "e_hero",
      "E",
      "Hero image and share card",
      has && h!.status === "ready" ? "pass" : "warn",
      !has
        ? h?.status === "pending"
          ? "Being made."
          : "No hero image yet."
        : h!.status === "fallback"
          ? "A title card for now: the image model didn't answer."
          : h!.status === "failed"
            ? "The last try wasn't saved, so the earlier image is in use."
            : "A 1600x900 hero and a 1200x630 share card.",
    );
  }

  const scored = items.filter((it) => it.id !== "e_hero");
  const points = scored.reduce((sum, it) => sum + (it.status === "pass" ? 1 : it.status === "warn" ? 0.5 : 0), 0);
  return { score: Math.round((points / scored.length) * 100), items, outline: o, figuresToCheck: unsupported };
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
