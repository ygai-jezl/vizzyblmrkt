import {
  articleLinks,
  blockPlain,
  countWords,
  lastUpdatedOf,
  parseArticle,
  plainInline,
  type ArticleBlock,
  type ArticleLink,
} from "./markdown";

/**
 * What a blog article is made of, read off its Markdown: the title, the "Last updated"
 * date, the opening answer, the Key facts and TL;DR boxes, the question sections, the
 * questions it answers and the source list. The checklist, the schema markup and the
 * preview all read this one outline. Pure + client-safe.
 *
 * It reads more than one shape of article. A section's direct answer may be its first
 * paragraph or an "Answer" box; the questions may sit in an FAQ section or as "###"
 * questions under any section; the close may be a "Next step" or a "Bottom line".
 */

export interface ArticleSection {
  heading: string;
  blocks: ArticleBlock[];
  /** Words in the section body (the heading is not counted). */
  words: number;
  /** The section's direct answer, as plain words: an "Answer" box when it opens with
   *  one, else its first paragraph. */
  lead: string;
}

export interface ArticleFaq {
  question: string;
  answer: string;
}

export interface ArticleOutline {
  /** The H1 as plain words; null when the article has none. */
  title: string | null;
  h1Count: number;
  /** YYYY-MM-DD from the "Last updated" line near the top; null when missing. */
  lastUpdated: string | null;
  /** The opening answer: the paragraphs between the H1 and the first box or section. */
  bluf: string;
  /** Key facts box items (inline Markdown); null when there is no such box. */
  keyFacts: string[] | null;
  /** TL;DR / key takeaways items; null when there is no such box. */
  tldr: string[] | null;
  /** The H2 sections that answer a question (not the FAQ, the sources or the close). */
  sections: ArticleSection[];
  /** The questions the article answers outright: the FAQ section's, else every "###"
   *  question with its answer straight under it. */
  faq: ArticleFaq[];
  /** The source list's items (inline Markdown); null when there is no Sources section. */
  sources: string[] | null;
  /** The closing section's blocks ("Next step", "The bottom line"); null when missing. */
  nextStep: ArticleBlock[] | null;
  /** Rows in each table (the header is not counted). */
  tableRows: number[];
  /** Lists in the body — the boxes, the FAQ and the source list don't count. */
  bodyLists: number;
  /** Heading-order problems, in words ("an H3 before any H2"). */
  hierarchyIssues: string[];
  words: number;
  /** The whole article as plain words (for finding a name in it). */
  plain: string;
  links: ArticleLink[];
}

const KEY_FACTS = /^key\s+(facts|numbers|stats|statistics)\b/i;
const TLDR = /^(tl\s*;?\s*dr|key\s+takeaways?|takeaways|at\s+a\s+glance)\b/i;
/** A box that holds a section's direct answer. */
const ANSWER = /^((the\s+)?(direct|quick|short)\s+answer|answer|in\s+short|the\s+short\s+version)\b/i;
const FAQ = /^(frequently\s+asked\s+questions|faqs?|common\s+questions|questions\s+(people|buyers)\s+ask)\b/i;
const SOURCES = /^(sources|references|citations|sources\s+and\s+references)\s*$/i;
const NEXT_STEP =
  /^(next\s+steps?|what\s+to\s+do\s+next|get\s+started|your\s+next\s+step|(the\s+)?bottom\s+line|conclusion|final\s+thoughts|wrapping\s+up)\b/i;

function firstList(blocks: ArticleBlock[]): string[] | null {
  const list = blocks.find((b) => b.kind === "list");
  return list?.kind === "list" ? list.items : null;
}

/** A labelled box's items, whichever way the writer drew the box: a blockquote with a
 *  bold label, a heading, or a bold line followed by a list. */
function labelledItems(blocks: ArticleBlock[], label: RegExp): string[] | null {
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    if (b.kind === "callout" && label.test(b.label)) {
      return firstList(b.blocks) ?? b.blocks.map(blockPlain).filter(Boolean);
    }
    const isLabel =
      (b.kind === "heading" && b.level >= 2 && label.test(plainInline(b.text))) ||
      (b.kind === "paragraph" && /^\*\*[^*]+\*\*:?$/.test(b.text.trim()) && label.test(plainInline(b.text)));
    if (isLabel) {
      const next = blocks[i + 1];
      if (next?.kind === "list") return next.items;
    }
  }
  return null;
}

/** The words inside a box, without its label. */
function boxText(block: ArticleBlock): string {
  return block.kind === "callout" ? block.blocks.map(blockPlain).filter(Boolean).join(" ") : blockPlain(block);
}

function leadOf(blocks: ArticleBlock[]): string {
  const first = blocks.find((b) => b.kind !== "rule");
  if (first?.kind === "callout" && ANSWER.test(first.label)) return boxText(first);
  const p = blocks.find((b) => b.kind === "paragraph");
  return p ? blockPlain(p) : "";
}

/** Words a reader reads — code (markup, a diagram) is not prose and is not counted. */
function wordsOf(blocks: ArticleBlock[]): number {
  return blocks.reduce((n, b) => n + (b.kind === "code" ? 0 : countWords(blockPlain(b))), 0);
}

/**
 * Questions and their answers: `### question` then its answer (prose, or an "Answer"
 * box), or `**question?**` lines. `questionsOnly` keeps a heading only when it is worded
 * as a question — for reading questions out of ordinary sections, where most "###"
 * headings are not one.
 */
function faqOf(blocks: ArticleBlock[], questionsOnly = false): ArticleFaq[] {
  const out: ArticleFaq[] = [];
  let question: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    if (question && answer.length) out.push({ question, answer: answer.join(" ").trim() });
    question = null;
    answer = [];
  };
  for (const b of blocks) {
    if (b.kind === "heading") {
      flush();
      const text = plainInline(b.text);
      question = b.level >= 3 && (!questionsOnly || /\?\s*$/.test(text)) ? text : null;
      continue;
    }
    if (b.kind === "rule" || b.kind === "code") continue;
    if (b.kind === "paragraph") {
      const bold = /^\*\*([^*]+\?)\*\*:?\s*(.*)$/.exec(b.text.trim());
      if (bold?.[1]) {
        flush();
        question = plainInline(bold[1]);
        if (bold[2]) answer.push(plainInline(bold[2]));
        continue;
      }
    }
    if (question) answer.push(boxText(b));
  }
  flush();
  return out;
}

export function outlineArticle(markdown: string): ArticleOutline {
  const blocks = parseArticle(markdown);
  const h1s = blocks.filter((b) => b.kind === "heading" && b.level === 1);
  const first = h1s[0];
  const title = first?.kind === "heading" ? plainInline(first.text) || null : null;

  // Split at H2s: everything before the first is the intro; each H2 owns what follows it.
  const firstH2 = blocks.findIndex((b) => b.kind === "heading" && b.level === 2);
  const intro = (firstH2 === -1 ? blocks : blocks.slice(0, firstH2)).filter(
    (b) => !(b.kind === "heading" && b.level === 1),
  );
  const chunks: { heading: string; blocks: ArticleBlock[] }[] = [];
  if (firstH2 !== -1) {
    for (const b of blocks.slice(firstH2)) {
      if (b.kind === "heading" && b.level === 2) chunks.push({ heading: plainInline(b.text), blocks: [] });
      else chunks[chunks.length - 1]?.blocks.push(b);
    }
  }

  let lastUpdated: string | null = null;
  const blufParts: string[] = [];
  for (const b of intro) {
    if (b.kind !== "paragraph") continue;
    const date = lastUpdatedOf(b.text);
    if (date) lastUpdated ??= date;
    else if (!/^\*\*[^*]+\*\*:?$/.test(b.text.trim())) blufParts.push(blockPlain(b));
  }

  const sections: ArticleSection[] = [];
  let faq: ArticleFaq[] | null = null;
  let sources: string[] | null = null;
  let nextStep: ArticleBlock[] | null = null;
  let bodyLists = intro.filter((b) => b.kind === "list").length;
  for (const c of chunks) {
    if (FAQ.test(c.heading)) faq = [...(faq ?? []), ...faqOf(c.blocks)];
    else if (SOURCES.test(c.heading)) sources = firstList(c.blocks) ?? c.blocks.map(blockPlain).filter(Boolean);
    else if (NEXT_STEP.test(c.heading)) nextStep ??= c.blocks;
    else if (KEY_FACTS.test(c.heading) || TLDR.test(c.heading)) continue; // a box drawn as a section
    else {
      sections.push({ heading: c.heading, blocks: c.blocks, words: wordsOf(c.blocks), lead: leadOf(c.blocks) });
      bodyLists += c.blocks.filter((b) => b.kind === "list").length;
    }
  }

  const hierarchyIssues: string[] = [];
  if (h1s.length === 0) hierarchyIssues.push("no H1 title");
  if (h1s.length > 1) hierarchyIssues.push(`${h1s.length} H1 titles (use one)`);
  let prev = 0;
  for (const b of blocks) {
    if (b.kind !== "heading") continue;
    if (prev && b.level > prev + 1) {
      hierarchyIssues.push(`an H${b.level} directly under an H${prev} ("${plainInline(b.text).slice(0, 60)}")`);
    }
    if (!prev && b.level > 1) hierarchyIssues.push("a section heading before the H1 title");
    prev = b.level;
  }

  const allBlocks = (list: ArticleBlock[]): ArticleBlock[] =>
    list.flatMap((b) => (b.kind === "callout" ? [b, ...allBlocks(b.blocks)] : [b]));

  return {
    title,
    h1Count: h1s.length,
    lastUpdated,
    bluf: blufParts.join(" ").trim(),
    keyFacts: labelledItems(blocks, KEY_FACTS),
    tldr: labelledItems(blocks, TLDR),
    sections,
    // No FAQ section → the questions the sections answer under their own "###" headings.
    faq: faq ?? sections.flatMap((sec) => faqOf(sec.blocks, true)),
    sources,
    nextStep,
    tableRows: allBlocks(blocks).flatMap((b) => (b.kind === "table" ? [b.rows.length] : [])),
    bodyLists,
    hierarchyIssues: [...new Set(hierarchyIssues)],
    words: wordsOf(blocks),
    plain: blocks
      .filter((b) => b.kind !== "code")
      .map(blockPlain)
      .filter(Boolean)
      .join("\n"),
    links: articleLinks(blocks),
  };
}
