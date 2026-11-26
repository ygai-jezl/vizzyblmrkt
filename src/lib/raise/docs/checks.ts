import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MAX_WORDS } from "./layouts";
import { CORE_SECTIONS } from "./outlines";
import { renderText, slideTextParts, slideWordsOf, stripTokens } from "./text";
import type { DeckAudience, MetricBlock, SectionKey, Slide } from "./types";
import { CHECK_WORDS, SECTION_IN_SENTENCE, SECTION_LABEL } from "./words";

/**
 * A deck's checks: hints on a slide or the whole deck. None blocks a save, Present or Save as PDF.
 * Pure: the same deck always gives the same checks, so the studio, Vizzy and a version's view agree.
 */

export const CHECK_CODES = [
  "number_no_source",
  "number_in_notes",
  "headline_label",
  "too_many_words",
  "missing_why_now",
  "missing_ask",
  "missing_repayment",
  "missing_section",
  "terms_on_ask",
  "cumulative_chart",
  "chart_no_source",
  "too_many_in_section",
  "house_style",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export interface Check {
  code: CheckCode;
  /** The slide it is about, or null for the whole deck. */
  slideId: string | null;
  message: string;
}

export interface CheckedDeck {
  audience: DeckAudience;
  slides: readonly Slide[];
}

/** Numbers typed into text: digits, with commas, a decimal part, a currency sign or a percent. Not part of a word (Q3, B2B). */
const NUMBER_RE = /(?<![\p{L}\p{N}_])[£$€]?\d(?:[\d,]*\d)?(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu;

const valueOf = (raw: string): number => Number(raw.replace(/[£$€,%]/g, ""));
const isYear = (raw: string) => /^\d{4}$/.test(raw) && Number(raw) >= 1900 && Number(raw) <= 2100;

/** The numbers in some text outside tokens, each once, without years. */
export function numbersIn(text: string): string[] {
  const found = [...stripTokens(text).matchAll(NUMBER_RE)].map((m) => m[0]).filter((n) => !isYear(n));
  return [...new Set(found)];
}

/** Every figure the deck's blocks show, as numbers: their values and each point of their series. */
function blockFigures(slides: readonly Slide[]): Set<number> {
  const out = new Set<number>();
  for (const s of slides) {
    for (const b of s.blocks) {
      if (b.value !== null) {
        out.add(b.value);
        out.add(Math.round(b.value));
        out.add(Math.abs(b.value));
      }
      for (const p of b.series ?? []) out.add(p.value);
      for (const n of numbersIn(b.display)) out.add(valueOf(n));
    }
  }
  return out;
}

const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

/** The headline only names its section, or says too little to make a point. */
function onlyLabel(slide: Slide): boolean {
  if (slide.section === "cover") return false;
  const h = normal(renderText(slide.headline, slide.blocks));
  if (h.split(" ").filter(Boolean).length < 3) return true;
  const names = [SECTION_LABEL[slide.section], SECTION_IN_SENTENCE[slide.section]].map(normal);
  return names.includes(h) || names.some((n) => h === `the ${n}` || h === `our ${n}`);
}

const TERMS_RE = /\b(valuation|pre[\s-]?money|post[\s-]?money|discount|term sheet|safe terms)\b/i;

const isSeries = (b: MetricBlock) => (b.grain === "week" || b.grain === "month") && (b.series?.length ?? 0) > 0;

/** Only ever goes up, over 4 or more points: it reads as a running total. */
function onlyRises(b: MetricBlock): boolean {
  const v = (b.series ?? []).map((p) => p.value);
  if (v.length < 4) return false;
  for (let i = 1; i < v.length; i += 1) if (v[i]! < v[i - 1]!) return false;
  return v[v.length - 1]! > v[0]!;
}

export function deckChecks(deck: CheckedDeck): Check[] {
  const out: Check[] = [];
  const figures = blockFigures(deck.slides);
  const sections = new Map<SectionKey, number>();
  for (const s of deck.slides) sections.set(s.section, (sections.get(s.section) ?? 0) + 1);

  for (const s of deck.slides) {
    const on = (code: CheckCode, message: string) => out.push({ code, slideId: s.id, message });

    // Numbers typed into the slide's words, rather than inserted as a block.
    const shown = [s.headline, ...s.points, ...(s.compare ? s.compare.rows.flatMap((r) => [r.left, r.right]) : [])].join("\n");
    for (const n of numbersIn(shown).slice(0, 3)) on("number_no_source", CHECK_WORDS.number_no_source(n));

    for (const n of numbersIn(s.notes).slice(0, 3)) {
      if (!figures.has(valueOf(n))) on("number_in_notes", CHECK_WORDS.number_in_notes(n));
    }

    if (onlyLabel(s)) on("headline_label", CHECK_WORDS.headline_label);

    const words = slideWordsOf(s);
    if (words > MAX_WORDS) on("too_many_words", CHECK_WORDS.too_many_words(words));

    if (deck.audience === "investor" && s.section === "ask") {
      const text = [...slideTextParts(s), ...s.blocks.map((b) => b.name)].join("\n");
      if (TERMS_RE.test(text)) on("terms_on_ask", CHECK_WORDS.terms_on_ask);
    }

    for (const b of s.blocks) {
      if (b.meaning === "typed" && onlyRises(b)) on("cumulative_chart", CHECK_WORDS.cumulative_chart);
      if (isSeries(b) && b.source.kind === "typed" && !b.source.from?.trim()) on("chart_no_source", CHECK_WORDS.chart_no_source);
    }

    const said = [...slideTextParts(s), renderText(s.notes, s.blocks)].join("\n");
    const found = [...dashesIn(said), ...aiTellsIn(said)][0];
    if (found) on("house_style", CHECK_WORDS.house_style(found));
  }

  const deckCheck = (code: CheckCode, message: string) => out.push({ code, slideId: null, message });
  if (deck.audience === "investor") {
    if (!sections.has("why_now")) deckCheck("missing_why_now", CHECK_WORDS.missing_why_now);
    if (!sections.has("ask")) deckCheck("missing_ask", CHECK_WORDS.missing_ask);
  } else if (!sections.has("repayment")) {
    deckCheck("missing_repayment", CHECK_WORDS.missing_repayment);
  }
  const ownCheck = new Set<SectionKey>(["why_now", "ask", "repayment"]);
  for (const section of CORE_SECTIONS[deck.audience]) {
    if (!ownCheck.has(section) && !sections.has(section)) deckCheck("missing_section", CHECK_WORDS.missing_section(SECTION_IN_SENTENCE[section]));
  }
  for (const [section, n] of sections) if (n > 3) deckCheck("too_many_in_section", CHECK_WORDS.too_many_in_section(n, SECTION_IN_SENTENCE[section]));
  return out;
}

/** A slide's own checks. */
export function checksFor(checks: readonly Check[], slideId: string): Check[] {
  return checks.filter((c) => c.slideId === slideId);
}
