import { z } from "zod";
import { generateJsonWithSchema, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import { aiUsage } from "@/lib/plans/meter";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import {
  ModelSlideSchema,
  audienceWords,
  authorsText,
  brandForPrompt,
  buildSlide,
  clip,
  fenced,
  needsFor,
  numbersText,
  outlineSlide,
  packText,
  renameTokens,
  requestsOf,
  responseSchema,
  teamPeople,
  type BuildCtx,
  type ModelSlide,
} from "./draft";
import { LAYOUTS, pointsCap } from "./layouts";
import { fillBlock, metricReader, refreshBlocks, typedBlock, type BlockRequest, type MetricDeps, type MetricReader, type NumberChange } from "./metrics";
import { AMOUNT_NEED, DEFAULT_LAYOUT, MISSING_SECTION, SECTION_BRIEF, guidanceFor, outlineFor } from "./outlines";
import { raiseContext, type RaisePack, type RaisePackDeps } from "./pack";
import { saveRaiseVersion, type RaiseResult, type StoreDeps } from "./store";
import { labelWords } from "./text";
import {
  BLOCK_UNITS,
  CURRENCIES,
  LAYOUT_KEYS,
  RAISE_DOC_LIMITS as L,
  SECTION_KEYS,
  newId,
  type LayoutKey,
  type MetricBlock,
  type PackLine,
  type RaiseDoc,
  type SectionKey,
  type Slide,
  type SlideNeed,
} from "./types";
import { BLOCK_SHORT, CHANGE_WARNINGS, MISSING_WORDS, NOTE_WORDS, OP_ISSUES, SECTION_LABEL } from "./words";

/**
 * Vizzy changing a saved deck (revise_raise_doc), one new version per request. Structural changes
 * (add a slide, remove, move, a layout, a number YouGrow fills, a number the person said in chat,
 * refresh the numbers) are done here in code and never reach the model. Text changes (rewrite a
 * slide, write its notes again, write a new slide) go to the model together in one call (prompt
 * raise.deck_revise, counted under raise_write), and code checks the answer as it checks a draft:
 * the model never writes a figure, a block already on a slide keeps its frozen value, and team
 * people come only from the brand's own list. Slides are named by their number in the version
 * Vizzy read; a deck that has moved on since is refused as stale. Always a draft: nothing is sent.
 */

export const REVISE_PROMPT = { id: "raise.deck_revise", version: 2 } as const;
export const REVISE_PROMPT_TAG = `${REVISE_PROMPT.id}@${REVISE_PROMPT.version}`;
export const REVISE_TIMEOUT_MS = 75_000;
const THINKING = 512;

// ----- The changes Vizzy can ask for -----------------------------------------------------------

const Pos = z.number().int().min(1);
const Ask = z.string().trim().min(1).max(600);
const Weeks = z.union([z.literal(4), z.literal(8), z.literal(12)]);

export const ReviseOpSchema = z.discriminatedUnion("change", [
  z.object({ change: z.literal("rewrite"), slide: Pos, ask: Ask }),
  z.object({ change: z.literal("notes"), slide: Pos, ask: Ask }),
  z.object({ change: z.literal("add"), after: z.number().int().min(0), section: z.enum(SECTION_KEYS), layout: z.enum(LAYOUT_KEYS).optional(), ask: z.string().trim().max(600).optional() }),
  z.object({ change: z.literal("remove"), slide: Pos }),
  z.object({ change: z.literal("move"), slide: Pos, to: Pos }),
  z.object({ change: z.literal("layout"), slide: Pos, layout: z.enum(LAYOUT_KEYS) }),
  z.object({ change: z.literal("number"), slide: Pos, meaning: z.enum(["waitlistSignups", "launchSignups", "signupGrowth"]), weeks: Weeks.optional(), launch: z.string().trim().max(80).optional() }),
  z.object({
    change: z.literal("typed_number"),
    slide: Pos,
    name: z.string().trim().min(1).max(L.typedName),
    value: z.number().finite().min(-L.maxValue).max(L.maxValue),
    unit: z.enum(BLOCK_UNITS),
    currency: z.enum(CURRENCIES).optional(),
    per: z.enum(["month", "year"]).optional(),
    from: z.string().trim().max(L.typedFrom).optional(),
    quote: z.string().trim().min(1).max(L.quote),
  }),
  z.object({ change: z.literal("refresh_numbers") }),
]);
export type ReviseOp = z.infer<typeof ReviseOpSchema>;

/** Each change checked on its own, so every problem comes back at once for Vizzy to fix. */
export function parseOps(raw: readonly unknown[]): { ok: true; ops: ReviseOp[] } | { ok: false; issues: string[] } {
  const ops: ReviseOp[] = [];
  const issues: string[] = [];
  raw.forEach((r, i) => {
    const p = ReviseOpSchema.safeParse(r);
    if (p.success) ops.push(p.data);
    else for (const issue of p.error.issues.slice(0, 4)) issues.push(`ops.${i}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
  });
  return issues.length ? { ok: false, issues } : { ok: true, ops };
}

/** Whether a request only refreshes the numbers (it then counts under the numbers limit). Safe on ops not yet checked. */
export const onlyRefresh = (ops: readonly unknown[]) =>
  ops.length > 0 && ops.every((o) => typeof o === "object" && o !== null && (o as { change?: unknown }).change === "refresh_numbers");

/** A language this runtime formats numbers for, else English: never the machine's own language. */
function numberLocale(locale: string): string {
  try {
    return Intl.NumberFormat.supportedLocalesOf(locale).length ? locale : "en";
  } catch {
    return "en";
  }
}

/** The decimal mark a locale writes: "." in English, "," in French or German. "." when unknown. */
export function decimalMark(locale: string): "." | "," {
  return new Intl.NumberFormat(numberLocale(locale)).formatToParts(1.5).find((p) => p.type === "decimal")?.value === "," ? "," : ".";
}

/** Whether a locale puts a space between thousands, as French, Swedish and Polish do ("14 200"). */
function groupsWithSpace(locale: string): boolean {
  const group = new Intl.NumberFormat(numberLocale(locale)).formatToParts(1234567).find((p) => p.type === "group")?.value ?? "";
  return /^\s$/.test(group);
}

const DIGIT = /^\p{Nd}$/u;

/** A digit's value in any script. Unicode keeps digits in runs of ten from 0 to 9, so it is the digit's place in its run. */
function digitValue(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let start = cp;
  while (DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/**
 * The quote with plain marks: full-width forms as ASCII, any script's digits as 0 to 9, Arabic marks
 * as "." and ",", an acute accent or prime between thousands as an apostrophe, every space as " ".
 */
function plainMarks(quote: string): string {
  return quote
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\p{Nd}/gu, (ch) => String(digitValue(ch.codePointAt(0)!)))
    .replace(/\u066b/g, ".")
    .replace(/[\u066c\u060c]/g, ",")
    .replace(/[\u00b4\u2032\u02bc]/g, "'")
    .replace(/\p{Zs}/gu, " ");
}

/** Scripts written without spaces between words, where a letter can sit right before a number ("月商12,500円"). */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Scripts that add endings to a scale word ("কোটির"), so the word needs no space after it. */
const SUFFIXED = /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}]/u;

/** Accents people often leave out (Latin and Greek accents, Arabic hamza and vowel marks, the Devanagari nukta): "milhoes", "الف", "करोड". */
const plainLetters = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f\u064b-\u065f\u0670\u093c]/g, "");

/**
 * Words for thousands or millions that people write in any language, beside the runtime's compact
 * numbers for the brand's language, English and Indian English: startup shorthand, finance codes
 * ("MEUR"), lakh and crore in Indian scripts, and the counting characters of Chinese, Japanese and Korean.
 */
const SCALE_WORDS_ANY = [
  "k", "mil", "mill", "bil", "bill", "tril", "mm", "bn", "bln", "tn", "trn", "hundred", "dozen", "thousand", "million", "billion", "trillion", "mille",
  "lakh", "lac", "crore", "cr", "tsd", "mrd", "mln", "mld", "mdd", "mdp", "mmdd", "mmdp", "milliers", "tkr", "mkr", "mnkr", "mdkr", "milj",
  "teur", "keur", "meur", "tusd", "kusd", "musd", "tgbp", "kgbp", "mgbp", "tchf", "kchf", "mchf", "tsek", "ksek", "msek", "knok", "mnok", "kdkk", "mdkk", "kpln", "mpln", "keuros", "meuros",
  "ngàn", "tỉ", "लाख", "करोड़", "লাখ", "লক্ষ", "কোটি", "லட்சம்", "கோடி", "లక్ష", "లక్షలు", "కోటి", "కోట్లు", "ಲಕ್ಷ", "ಕೋಟಿ", "ലക്ഷം", "കോടി", "લાખ", "કરોડ", "ਲੱਖ", "ਕਰੋੜ",
  "十", "百", "千", "万", "萬", "億", "亿", "兆", "백", "천", "만", "억", "조",
];
/** Scale letters only when glued to the digits: "50к" is 50 thousand, "6.2w" is 6.2 万, but Polish "300 w listopadzie" is "in November". */
const GLUED_ONLY = ["к", "w"];
/** Words that are a scale only with their dot: German "Bio." is a billion and "Bio" organic; Swiss "Mia." is a billion and "Mia" a name. */
const SCALE_WITH_DOT = new Set(["bio", "mia"]);
/** Scale words that are other words elsewhere, for one language only: French "grand" is big and "mn" minutes; Dutch "ton" is 100,000 euros. */
const SCALE_WORDS_OF: Record<string, string[]> = {
  en: ["grand", "mn", "thou"],
  nl: ["ton"],
  // Polish case endings the runtime's compact numbers don't give: "z 2 milionami", "w 3 milionach".
  pl: ["milionami", "milionach", "milionom", "miliardami", "miliardach", "tysiącami", "tysiącach", "tysiącom"],
};
/** Vulgar fractions: "2½" is never 2. */
const FRACTIONS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";

type Scale = { glued: RegExp; spaced: RegExp; letter: RegExp; header: RegExp };
const scales = new Map<string, Scale>();

/** The scale words of one brand language as patterns, built once from the runtime's compact numbers. */
function scaleFor(locale: string): Scale {
  const key = numberLocale(locale);
  const hit = scales.get(key);
  if (hit) return hit;
  const words = new Set([...SCALE_WORDS_ANY, ...(SCALE_WORDS_OF[key.split("-")[0]!.toLowerCase()] ?? []), "mia"].map(plainLetters));
  const letters = new Set(["K", "M", "B", "T", "L"]);
  for (const l of new Set([key, "en", "en-IN"])) {
    for (const compactDisplay of ["short", "long"] as const) {
      const nf = new Intl.NumberFormat(l, { notation: "compact", compactDisplay });
      // Up to trillions: the words past them are other words too (Hindi "नील" begins "नीले", blue).
      for (let e = 3; e <= 12; e++) {
        // 1, 2, 5, 1.5 and 21 reach each plural form: "1 milion", "2 miliony", "5 milionów", "1,5 miliona".
        for (const v of [1, 2, 5, 1.5, 21]) {
          if (v * 10 ** e >= 1e13) continue;
          const word = plainLetters(nf.formatToParts(v * 10 ** e).filter((p) => p.type === "compact").map((p) => p.value).join("").trim().replace(/\.+$/, ""));
          if (!word) continue;
          // One letter is a scale only as a capital ("1.2 M"), or glued to the digits ("6.2k").
          if ([...word.replace(/[^\p{L}]/gu, "")].length === 1 && !UNSPACED.test(word)) letters.add(word.toUpperCase());
          else words.add(word);
        }
      }
    }
  }
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const free = sorted.filter((w) => UNSPACED.test(w[0]!) || SUFFIXED.test(w[0]!)).map(esc);
  const plain = sorted.filter((w) => !(UNSPACED.test(w[0]!) || SUFFIXED.test(w[0]!)));
  const words2 = plain.filter((w) => !SCALE_WITH_DOT.has(w.toLowerCase())).map(esc);
  const dotted = plain.filter((w) => SCALE_WITH_DOT.has(w.toLowerCase())).map((w) => `${esc(w)}\\.`);
  const oneLetter = [...letters].map(esc);
  const any = [...free, ...words2, ...dotted, ...oneLetter].join("|");
  // A letter after a scale word ends it only in a script with spaces: "$1.2Mです" is 1.2 million.
  const notWord = "(?!(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])[\\p{L}\\p{M}&'\u2019])";
  const scale: Scale = {
    // Glued to the digits: "6.2k", "10k-strong", "10K's", "2M5", "1,2Mio", "1万", "2½". Never "5Mbps", "12km" or "120m²".
    glued: new RegExp(`^(?!m[23\u00b2\u00b3](?!\\d))(?:(?:${[...words2, ...dotted, ...oneLetter, ...GLUED_ONLY].join("|")})(?:['\u2019]?s)?\\.?${notWord}|(?:${free.join("|")})|[${FRACTIONS}])`, "iu"),
    // After a space or a hyphen: "1.2 million", "2 millions", "$1.5-million-dollar", "2-Millionen-Euro-Runde", "1,2 Mio.", "6 and a half million".
    // Never "40 Bio Produkte", and never a lone letter (that is `letter`), so "200 K-12 schools" keeps 200.
    spaced: new RegExp(
      `^(?: {1,2}| ?\\p{Pd} ?)(?:and an? (?:half|quarter) )?(?:(?:${[...words2.filter((w) => [...w.replace(/[^\p{L}]/gu, "")].length > 1), ...dotted].join("|")})s?\\.?(?![\\p{L}\\p{M}\\p{N}&'\u2019])|(?:${free.join("|")}))`,
      "iu",
    ),
    // A capital letter on its own after a space: "1.2 M", "1.2 M+", "₹50 L". Never "2 t Kaffee", "800 l", "4 l'an" or "M/M".
    letter: new RegExp(`^ {1,2}(?:${oneLetter.join("|")})(?=$|[\\s.,;:!?)\\]%+\\p{Sc}])`, "u"),
    // One scale word on its own, for a header: "k", "millions", "Mio.", "千".
    header: new RegExp(`^(?:${any})s?\\.?$`, "iu"),
  };
  scales.set(key, scale);
  return scale;
}

/**
 * Whether a word for thousands or millions comes right after a number: glued, after a space or after a
 * hyphen. After money ("$1.5 m", "£1.2 m") a small letter counts too, which "85 m²" or "800 l" don't.
 */
function scaledAfter(scale: Scale, rest: string, afterMoney: boolean): boolean {
  const r = plainLetters(rest);
  if (scale.glued.test(r) || scale.spaced.test(r) || scale.letter.test(r)) return true;
  return afterMoney && /^ {1,2}[kmb](?=$|[\s.,;:!?)\]%+])/u.test(r);
}

/** Money: a currency sign, an ISO code such as "EUR" or "US$", or the yen, yuan or won character. */
const MONEY = /\p{Sc}|\b[A-Z]{2,3}\$?(?!\p{L})|[円元원]/u;

/**
 * Whether the words name a scale for every figure, as a table header does: "MRR ($k):", "(€m)",
 * "(EUR m)", "(in $ millions)", "(₹ in lakhs)", "(in thousands of dollars)", "(£000)", "(en k€)",
 * "(w tys. zł)", "（千円）", "figures in thousands:". Never a lettered list or a size: "(b)", "(M)".
 */
function scaleHeader(scale: Scale, text: string): boolean {
  for (const m of text.matchAll(/[([]([^()[\]\d]{1,48}|[^()[\]\d]{0,6}['\u2019]?000s?[^()[\]\d]{0,6})[)\]]/gu)) {
    const inside = m[1]!;
    const money = MONEY.test(inside);
    if (/000s?/.test(inside) && (money || /^\s*['\u2019]?000s?\s*$/.test(inside))) return true;
    for (const w of plainLetters(inside).split(/[\s:\uff1a,;/'\u2019]+|(?<=\p{Sc})|(?=\p{Sc})/u)) {
      // "千円", "百万円": a counting character before the currency.
      if (/^[十百千万萬億亿兆백천만억조]+[円元원]$/.test(w)) return true;
      if (!w || !scale.header.test(w)) continue;
      // A lone letter ("(b)", "(M)") is a scale only beside money: "($k)", "(EUR m)".
      if (money || [...w.replace(/[^\p{L}]/gu, "")].length > 1 || UNSPACED.test(w)) return true;
    }
  }
  return /\b(?:in|en|em|w)\s+(?:\p{Sc}\s*|[A-Z]{2,3}\$?\s+)?(?:thousands|millions|billions|lakhs|crores|k|m|bn|mn|mio\.?|tsd\.?|tys\.?|mln|milliers|miles|millones|milhares|migliaia)(?![\p{L}\p{N}])\s*(?:[:)]|$)/imu.test(text);
}

/**
 * Whether what comes right before a run ties its first digits to something that isn't a number of its
 * own: the minutes of "12:30", "14h30", "14 h 30", "14時30" or "2시 30분", the "11" of "27/11" or
 * "2025-11-27", the "12" of "K-12", the "5" of ".5", the rest of "1万2000", or a label's digits ("Q3",
 * "FY24", "Q3'25"). "Rs.6,200", "c.500", "doubled—1,200" and "in 24h 1,200 people" hold their numbers.
 */
function tiedBefore(text: string, at: number): boolean {
  const c = text[at - 1];
  if (c === undefined) return false;
  const c2 = text[at - 2] ?? "";
  if (c === ":" || c === "/") return /\d/.test(c2);
  if (c === "." || c === ",") return !/[\p{L}\p{M}]/u.test(c2);
  if (/[-\u2010\u2011]/.test(c)) return /[\p{L}\d]/u.test(c2);
  if (c === "\u2013") return /\d/.test(c2);
  if (/\p{L}/u.test(c) && !UNSPACED.test(c)) return true;
  const before = text.slice(Math.max(0, at - 4), at);
  if (/\d ?[時点시] ?$|[万萬億亿兆千百만억천조] ?$/.test(before)) return true;
  // "14 h 30": minutes after an hour, never a count ("en 48 h 1 200 inscrits" is 1200).
  return /\d ?h $/i.test(before) && /^[0-5]\d(?!\d|[.,'\u2019]\d| \d{3}(?!\d))/.test(text.slice(at));
}

type Found = { value: number; start: number; end: number };

/** What a quote holds: its numbers, and whether it names a figure in thousands or millions anywhere (then it holds none). */
export type QuoteNumbers = { numbers: number[]; scaled: boolean };

/**
 * Every number in someone's words, read in one pass with the brand language's marks. A number is
 * digits with a thousands mark between groups of three (the same mark all the way: the other of
 * "." and ",", an apostrophe, a space where the language writes one, or lakh), then a decimal part.
 * A decimal mark is the language's own, or the other of "." and "," before anything but three
 * digits when nothing or only apostrophes and spaces come before it ("1,5" in English, "CHF 1'234.50"
 * in German).
 *
 * Words that name a figure in thousands or millions anywhere ("$6.2k", "1,2 Millionen", "2, maybe 3
 * million", "MRR ($k):") hold no figure at all, so a figure beside them must be quoted on its own words.
 * Read nothing rather than a number the words don't mean: never a run glued to another by a mark
 * ("27.11.2026", "1,234,5"), a date's or a time's parts ("27/11", "12:30", "2025-11-27"), the first end
 * of a range ("5-6,000"), a label's digits ("Q3 250" holds 250, never 3250), a leading zero ("007") or,
 * in a language that doesn't put a space between thousands, a short group then three digits ("3 250").
 * A mark then a space ("2025, 1 200"), a line break and a space between numbers that can't be one ("in
 * 2025 250 brands") all separate numbers. Any script's digits and full-width forms are read. Pure.
 */
export function readQuote(quote: string, locale = "en"): QuoteNumbers {
  const text = plainMarks(quote);
  const dec = decimalMark(locale);
  const other = dec === "," ? "." : ",";
  const marks = new Set([other, " ", "'", "\u2019"]);
  const spaced = groupsWithSpace(locale);
  const scale = scaleFor(locale);
  const read = (raw: string) => readNumber(raw, dec, other, marks);
  const found: Found[] = [];
  let scaled = scaleHeader(scale, text);

  // One stretch of digits and marks that a mark then a space hasn't cut, starting at `at`.
  const segment = (at: number, raw: string): void => {
    const seg = raw.replace(/[.,'\u2019 ]+$/, "");
    if (!seg) return;
    if (tiedBefore(text, at)) {
      // The first end of a range or a date ("5-6,000", "27/11", "12:30") goes too.
      const last = found[found.length - 1];
      const mark = text[at - 1]!;
      if (last && last.end === at - 1) {
        const lead = Number(/^\d+/.exec(seg)?.[0] ?? NaN);
        const date = Number.isInteger(last.value) && last.value <= 31 && lead <= 31;
        if (/[-\u2010\u2011\u2013]/.test(mark) || (mark === "/" && date) || (mark === ":" && /^\d\d(?!\d)/.test(seg))) found.pop();
      }
      // Leave out the tied stretch, and read what follows it after a space as a run of its own.
      const lead = /^\S+ +/.exec(seg)?.[0];
      if (lead) segment(at + lead.length, seg.slice(lead.length));
      return;
    }
    const pieces = [...seg.matchAll(/[^ ]+/g)].map((p) => ({ raw: p[0], start: at + (p.index ?? 0) }));
    const keep = (i: number, j: number, value: number | null) => {
      if (value !== null) found.push({ value, start: pieces[i]!.start, end: pieces[j]!.start + pieces[j]!.raw.length });
    };
    if (pieces.length === 1) keep(0, 0, read(seg));
    else if (spaced) {
      // A language that writes a space between thousands: the longest stretch that reads as one number first.
      for (let i = 0; i < pieces.length; ) {
        let j = pieces.length;
        let value: number | null = null;
        for (; j > i; j--) {
          value = read(pieces.slice(i, j).map((p) => p.raw).join(" "));
          if (value !== null) break;
        }
        if (value === null) i++;
        else {
          keep(i, j - 1, value);
          i = j;
        }
      }
    }
    // "3 250" could be one number in a language that doesn't write it so: read neither.
    else if (!pieces.some((p, i) => /^\d{1,3}$/.test(p.raw) && /^\d{3}(?!\d)/.test(pieces[i + 1]?.raw ?? ""))) {
      pieces.forEach((p, i) => keep(i, i, read(p.raw)));
    }
  };

  for (const m of text.matchAll(/\d[\d.,'\u2019 ]*/g)) {
    const run = m[0];
    const start = m.index ?? 0;
    let from = 0;
    for (const cut of run.matchAll(/(?<=[.,'\u2019]) +/g)) {
      segment(start + from, run.slice(from, cut.index));
      from = (cut.index ?? 0) + cut[0].length;
    }
    segment(start + from, run.slice(from));
    if (scaled) continue;
    const end = start + run.replace(/[.,'\u2019 ]+$/, "").length;
    // A scale word after a number, or after the second end of a range ("$5-6k"), but not after a label's digits ("B2B").
    const last = found[found.length - 1];
    const digitsStart = end - (/\d[\d.,'\u2019]*$/.exec(text.slice(start, end))?.[0].length ?? 0);
    const ownNumber = last !== undefined && last.end === end;
    const afterMoney = MONEY.test(text.slice(Math.max(0, digitsStart - 4), digitsStart).trimEnd().slice(-3));
    if ((ownNumber || /[\p{Pd}~/]/u.test(text[digitsStart - 1] ?? "")) && scaledAfter(scale, text.slice(end, end + 40), afterMoney)) scaled = true;
  }
  return { numbers: scaled ? [] : found.map((f) => f.value), scaled };
}

/** The numbers in someone's words (see readQuote). */
export function numbersIn(quote: string, locale = "en"): number[] {
  return readQuote(quote, locale).numbers;
}

/** One run of digits and marks as a number, or null when it isn't one number. */
function readNumber(raw: string, dec: string, other: string, marks: ReadonlySet<string>): number | null {
  const parts = raw.split(/([^\d])/);
  const digits = parts.filter((_, k) => k % 2 === 0);
  const seps = parts.filter((_, k) => k % 2 === 1);
  if (digits.some((d) => d === "")) return null;
  if (!seps.length) return /^0\d/.test(raw) ? null : Number(raw);
  // The last mark is the decimal mark when it is the language's, or the other one before anything but
  // three digits with only apostrophes or spaces before it.
  const last = seps[seps.length - 1]!;
  const tail = digits[digits.length - 1]!;
  const decimal = last === dec || (last === other && tail.length !== 3 && seps.slice(0, -1).every((s) => s === " " || s === "'" || s === "\u2019"));
  const groups = decimal ? seps.slice(0, -1) : seps;
  const intParts = decimal ? digits.slice(0, -1) : digits;
  if (groups.length) {
    const mark = groups[0]!;
    if (!marks.has(mark) || groups.some((g) => g !== mark)) return null;
    const lakh = mark === "," && intParts.length >= 3 && intParts.slice(1, -1).every((d) => d.length === 2) && intParts[intParts.length - 1]!.length === 3;
    const three = intParts.slice(1).every((d) => d.length === 3);
    if (intParts[0]!.length > 3 || !(three || lakh)) return null;
  }
  const whole = intParts.join("");
  if (/^0\d/.test(whole)) return null;
  return Number(decimal ? `${whole}.${tail}` : whole);
}

/**
 * Whether the person's own words hold this number, read with the marks of the brand's language
 * (`locale`): one of readQuote's numbers is it exactly. In English "$6,200 a month" holds 6200 and
 * "0.125%" holds 0.125; in French or German "12,5 %" holds 12.5 (never 12 or 125) and "6.200 €"
 * holds 6200 (never 6.2). "about 6k" holds neither 6 nor 6000, so Vizzy asks for the figure rather
 * than turning words into a number.
 */
export function quoteHas(value: number, quote: string, locale = "en"): boolean {
  const want = Math.abs(value);
  if (!Number.isFinite(want)) return false;
  return numbersIn(quote, locale).some((n) => n === want);
}

// ----- Helpers ---------------------------------------------------------------------------------

/** The Needs a number on this slide answers: once the slide holds a number, it stops asking for one. */
export function settledNeeds(section: SectionKey, blocks: readonly MetricBlock[], needs: SlideNeed[]): SlideNeed[] {
  if (!blocks.length) return needs;
  const answered = new Set<string>();
  for (const k of ["demand", "market", "sales"] as const) if (MISSING_SECTION[k] === section) answered.add(MISSING_WORDS[k]);
  const amount = AMOUNT_NEED[section];
  if (amount && blocks.some((b) => b.unit === "money")) answered.add(amount);
  return needs.filter((n) => !answered.has(n.text));
}

const withNeed = (needs: SlideNeed[], text: string): SlideNeed[] =>
  needs.some((n) => n.text === text) || needs.length >= L.needs ? needs : [...needs, { id: newId("nd"), text: clip(text, L.need) }];

/**
 * The fresh pack's lines under the deck's own ids: a line the deck already holds keeps its id, so
 * older slides' sources still point at the right words, and a new one takes the next free id while
 * there is room (30 at most). `sources` is what the deck keeps.
 */
export function mergeLines(stored: readonly PackLine[], fresh: readonly PackLine[]): { lines: PackLine[]; sources: PackLine[] } {
  const key = (l: PackLine) => `${l.label}|${l.text}`;
  const byKey = new Map(stored.map((l) => [key(l), l]));
  const used = new Set(stored.map((l) => l.id));
  const sources = [...stored];
  const lines: PackLine[] = [];
  let next = 1;
  for (const l of fresh) {
    const have = byKey.get(key(l));
    if (have) {
      lines.push(have);
      continue;
    }
    if (sources.length >= L.sources) continue;
    while (used.has(`P${next}`)) next += 1;
    const line = { ...l, id: `P${next}` };
    used.add(line.id);
    byKey.set(key(line), line);
    sources.push(line);
    lines.push(line);
  }
  return { lines, sources };
}

// ----- The prompt ------------------------------------------------------------------------------

type TaskKind = "rewrite" | "notes" | "new";
interface Task {
  ref: string;
  kind: TaskKind;
  /** The slide it changes, or the new slide's id. */
  id: string;
  ask: string;
  section?: SectionKey;
  layout?: LayoutKey;
}


function slideText(s: Slide, n: number, now: Date): string {
  const lines = [`Slide ${n} (${s.section}, layout ${s.layout}):`, `Headline: ${fenced(s.headline)}`];
  for (const p of s.points) lines.push(`Point: ${fenced(p)}`);
  if (s.compare) {
    lines.push(`Columns: ${fenced(s.compare.leftTitle)} | ${fenced(s.compare.rightTitle)}`);
    for (const r of s.compare.rows) lines.push(`Row: ${fenced(r.left)} | ${fenced(r.right)}`);
  }
  for (const p of s.people ?? []) lines.push(`Person: ${fenced(p.name)}, ${fenced(p.role)}: ${fenced(p.line)}`);
  for (const b of s.blocks) lines.push(`Number {{${b.id}}}: ${fenced(b.display) || "none yet"} (${fenced(b.name)}${b.periodWords ? `, ${fenced(b.periodWords)}` : ""}, ${fenced(labelWords(b, now))})`);
  if (s.notes) lines.push(`Notes: ${fenced(s.notes)}`);
  for (const need of s.needs) lines.push(`Needs: ${fenced(need.text)}`);
  return lines.join("\n");
}

function taskText(t: Task, n: number, audience: RaiseDoc["audience"]): string {
  const asked = t.ask ? ` Asked: "${fenced(t.ask)}"` : "";
  if (t.kind === "rewrite") return `${t.ref}: rewrite slide ${n}.${asked}`;
  if (t.kind === "notes") return `${t.ref}: notes for slide ${n}.${asked}`;
  const section = t.section!;
  return `${t.ref}: new slide ${n}, section ${section} (${SECTION_LABEL[section]}), layout ${t.layout}: ${SECTION_BRIEF[section]}. ${guidanceFor(section, audience)}${asked}`;
}

export function revisePrompt(doc: RaiseDoc, slides: readonly Slide[], tasks: readonly Task[], pack: RaisePack, now: Date): string {
  const pos = new Map(slides.map((s, i) => [s.id, i + 1]));
  const newIds = new Set(tasks.filter((t) => t.kind === "new").map((t) => t.id));
  return renderPrompt(REVISE_PROMPT.id, {
    brand_name: brandForPrompt(pack.brandName),
    audience_words: audienceWords(doc.audience, doc.stage),
    deck: slides
      .filter((s) => !newIds.has(s.id))
      .map((s) => slideText(s, pos.get(s.id)!, now))
      .join("\n\n"),
    tasks: tasks.map((t) => taskText(t, pos.get(t.id) ?? 0, doc.audience)).join("\n"),
    voice: fenced(pack.voice) || "(none set: plain, warm and direct)",
    pack: packText(pack),
    authors: authorsText(pack),
    numbers: numbersText(pack),
    today: now.toISOString().slice(0, 10),
  });
}

/** The answer's shape: the draft's slide shape, named by task instead of by section and layout. */
export function reviseSchema(): Record<string, unknown> {
  const draft = responseSchema() as { properties: { slides: { items: { properties: Record<string, unknown> } } } };
  const { section: _s, layout: _l, ...props } = draft.properties.slides.items.properties;
  return {
    type: "object",
    properties: { slides: { type: "array", items: { type: "object", properties: { task: { type: "string" }, ...props }, required: ["task", "notes"] } } },
    required: ["slides"],
  };
}

const ReviseAnswer = z.object({ slides: z.array(ModelSlideSchema.extend({ task: z.string().catch("") })) });

/** The model's slides by task id; null when the answer can't be read at all. */
function answerOf(raw: unknown): Map<string, ModelSlide> | null {
  const p = ReviseAnswer.safeParse(raw);
  if (!p.success) return null;
  const out = new Map<string, ModelSlide>();
  for (const s of p.data.slides) if (/^T\d$/.test(s.task.trim()) && !out.has(s.task.trim())) out.set(s.task.trim(), s);
  return out;
}

// ----- Text changes ----------------------------------------------------------------------------

interface TextCtx extends BuildCtx {
  stage: RaiseDoc["stage"];
}

/** A slide rewritten as the model answered: its own blocks kept frozen, new ones filled by the server. */
async function rewritten(s: Slide, m: ModelSlide, n: number, c: TextCtx, warnings: string[]): Promise<Slide> {
  const keep = new Set(s.blocks.map((b) => b.id));
  const asked = requestsOf(m, c.pack, warnings, n, L.blocks - s.blocks.length);
  const ids = new Map<string, string>();
  const blocks = [...s.blocks];
  const needTexts: string[] = [];
  for (const { key, req } of asked) {
    const f = await fillBlock(c.reader, req);
    if (f.warning) warnings.push(f.warning);
    if (f.block.value === null) {
      if (f.need) needTexts.push(f.need);
      continue;
    }
    ids.set(key, f.block.id);
    blocks.push(f.block);
  }
  const dropped: string[] = [];
  const t = (text: string, max: number) => clip(renameTokens(text, ids, dropped, keep), max);
  const headline = t(m.headline, L.headline) || s.headline;
  const points = m.points.map((p) => t(p, L.point)).filter(Boolean).slice(0, pointsCap(s.layout, s.section, c.stage));
  const notes = t(m.notes, L.notes) || s.notes;
  const compare =
    s.layout === "compare" && m.compare && m.compare.rows.length
      ? {
          leftTitle: clip(m.compare.leftTitle, L.compareTitle) || s.compare?.leftTitle || "Today",
          rightTitle: clip(m.compare.rightTitle, L.compareTitle) || s.compare?.rightTitle || "With us",
          rows: m.compare.rows
            .map((r) => ({ left: t(r.left, L.compareCell), right: t(r.right, L.compareCell) }))
            .filter((r) => r.left || r.right)
            .slice(0, L.compareRows),
        }
      : undefined;
  const people = (s.section === "team" || s.layout === "team") && m.people.length ? teamPeople(m.people, c.pack, n, warnings) : undefined;
  if (dropped.length) warnings.push(`Slide ${n} named a number it didn't ask for, so it was left out.`);
  const known = new Set(c.pack.lines.map((l) => l.id));
  const sources = [...new Set(m.sources.map((x) => x.trim()).filter((x) => known.has(x)))].slice(0, L.sources);
  return {
    ...s,
    headline,
    points,
    ...(compare ? { compare } : {}),
    ...(people ? { people } : {}),
    blocks,
    notes,
    needs: settledNeeds(s.section, blocks, needsFor(s.section, c.pack, [...m.needs, ...needTexts])),
    sources: sources.length ? sources : s.sources,
    ai: { headline, points, notes, at: c.now.toISOString(), prompt: REVISE_PROMPT_TAG },
  };
}

/** Only the slide's notes again, as the model answered; the rest of the slide as it was. */
function withNotes(s: Slide, m: ModelSlide, c: TextCtx): Slide | null {
  const dropped: string[] = [];
  const notes = clip(renameTokens(m.notes, new Map(), dropped, new Set(s.blocks.map((b) => b.id))), L.notes);
  if (!notes) return null;
  return { ...s, notes, ai: { headline: s.ai?.headline ?? s.headline, points: s.ai?.points ?? s.points, notes, at: c.now.toISOString(), prompt: REVISE_PROMPT_TAG } };
}

// ----- Revise ----------------------------------------------------------------------------------

export interface ReviseInput {
  ops: ReviseOp[];
  /** The version Vizzy read: slides are named by their number in it. */
  baseVersion: number;
  /** Vizzy's change note; without one the server writes it from the difference. */
  note?: string;
}

export interface ReviseDeps extends StoreDeps {
  pack?: Omit<RaisePackDeps, "reader">;
  metrics?: MetricDeps;
  generate?: typeof generateJsonWithSchema;
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

export interface Revised {
  doc: RaiseDoc;
  /** False when nothing changed: no new version was made. */
  saved: boolean;
  warnings: string[];
  /** The numbers a refresh moved. */
  changed: NumberChange[];
}

const fail = (status: number, error: string, extra: { issues?: string[]; version?: number } = {}): RaiseResult<never> => ({ ok: false, status, error, ...extra });

/**
 * Apply Vizzy's changes to the deck as it is (version `baseVersion`) and save one new version, by
 * Vizzy. The caller has checked the switch, the role, brandCanUse and the limits.
 */
export async function reviseDeck(ctx: TenantContext, doc: RaiseDoc, input: ReviseInput, deps: ReviseDeps = {}): Promise<RaiseResult<Revised>> {
  if (doc.version !== input.baseVersion) return fail(409, "stale_version", { version: doc.version });
  const now = deps.now?.() ?? new Date();
  const reader: MetricReader = metricReader(ctx, { db: deps.db, ...deps.metrics, now: () => now });
  const read = doc.current.slides;
  const work: Slide[] = [...read];
  const issues: string[] = [];
  const warnings: string[] = [];
  const tasks: Task[] = [];
  const removed = new Set<string>();
  let refresh = false;
  // The brand, read once: its language sets how a typed number is read, and the pack needs it.
  // undefined when it couldn't be read, null when there is none.
  let tenantRead: Promise<Tenant | null | undefined> | null = null;
  const tenantOnce = () => (tenantRead ??= (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => undefined));

  const idAt = (pos: number, i: number): string | null => {
    const s = read[pos - 1];
    if (!s) issues.push(`ops.${i}: ${OP_ISSUES.noSlide(pos, read.length)}`);
    else if (removed.has(s.id)) issues.push(`ops.${i}: ${OP_ISSUES.removed(pos)}`);
    else return s.id;
    return null;
  };
  const at = (id: string) => work.findIndex((s) => s.id === id);
  const update = (id: string, f: (s: Slide) => Slide) => {
    const i = at(id);
    work[i] = f(work[i]!);
  };

  for (const [i, op] of input.ops.entries()) {
    switch (op.change) {
      case "rewrite":
      case "notes": {
        const id = idAt(op.slide, i);
        if (id) tasks.push({ ref: `T${tasks.length + 1}`, kind: op.change, id, ask: op.ask });
        break;
      }
      case "add": {
        let index = 0;
        if (op.after > 0) {
          const id = idAt(op.after, i);
          if (!id) break;
          index = at(id) + 1;
        }
        if (work.length >= L.slides) {
          issues.push(`ops.${i}: ${OP_ISSUES.tooMany}`);
          break;
        }
        const id = newId("sl");
        const layout = op.layout ?? DEFAULT_LAYOUT[op.section];
        work.splice(index, 0, { id, section: op.section, layout, headline: SECTION_LABEL[op.section], points: [], blocks: [], notes: "", needs: [], sources: [] });
        tasks.push({ ref: `T${tasks.length + 1}`, kind: "new", id, ask: op.ask ?? "", section: op.section, layout });
        break;
      }
      case "remove": {
        const id = idAt(op.slide, i);
        if (!id) break;
        if (work.length <= L.minSlides) issues.push(`ops.${i}: ${OP_ISSUES.tooFew}`);
        else if (tasks.some((t) => t.id === id)) issues.push(`ops.${i}: ${OP_ISSUES.removed(op.slide)}`);
        else {
          work.splice(at(id), 1);
          removed.add(id);
        }
        break;
      }
      case "move": {
        const id = idAt(op.slide, i);
        if (!id) break;
        if (op.to > work.length) {
          issues.push(`ops.${i}: ${OP_ISSUES.noPlace(op.to, work.length)}`);
          break;
        }
        const [s] = work.splice(at(id), 1);
        work.splice(op.to - 1, 0, s!);
        break;
      }
      case "layout": {
        const id = idAt(op.slide, i);
        if (id) update(id, (s) => ({ ...s, layout: op.layout }));
        break;
      }
      case "number":
      case "typed_number": {
        const id = idAt(op.slide, i);
        if (!id) break;
        const s = work[at(id)]!;
        if (s.blocks.length >= L.blocks) {
          issues.push(`ops.${i}: ${OP_ISSUES.full(op.slide)}`);
          break;
        }
        if (op.change === "typed_number") {
          const brand = await tenantOnce();
          // Unread, the number must be held whichever way its marks are read.
          const locales = brand === undefined ? ["en", "de"] : [brand?.defaultLocale ?? "en"];
          if (!locales.every((l) => quoteHas(op.value, op.quote, l))) {
            // Words that name a figure in thousands or millions hold none: Vizzy quotes only the words with this one.
            const digits = String(Math.abs(op.value));
            const issue = locales.some((l) => readQuote(op.quote, l).scaled) ? OP_ISSUES.scaledQuote(digits) : OP_ISSUES.notInQuote(digits);
            return fail(422, "quote_mismatch", { issues: [`ops.${i}.quote: ${issue}`] });
          }
          const b = typedBlock(
            { name: op.name, value: op.value, unit: op.unit, currency: op.currency, per: op.per ?? null, from: op.from },
            { typedBy: ctx.userId ?? "vizzy", saidInChat: true, quote: op.quote },
            now,
          );
          const blocks = [...s.blocks, b];
          update(id, (x) => ({ ...x, blocks, needs: settledNeeds(x.section, blocks, x.needs) }));
          if (LAYOUTS[s.layout].blocks === 0) warnings.push(CHANGE_WARNINGS.layoutHidesNumbers(op.slide));
          break;
        }
        let req: BlockRequest;
        if (op.meaning === "launchSignups") {
          if (!op.launch) {
            issues.push(`ops.${i}.launch: ${OP_ISSUES.needsLaunch}`);
            break;
          }
          const launches = await reader.launches();
          if (!launches) {
            issues.push(`ops.${i}: ${OP_ISSUES.noPeopleList}`);
            break;
          }
          const want = op.launch.toLowerCase();
          const launch = launches.find((l) => l.id === op.launch) ?? launches.find((l) => l.name.trim().toLowerCase() === want);
          if (!launch) {
            issues.push(`ops.${i}.launch: ${OP_ISSUES.noLaunch(op.launch)}`);
            break;
          }
          req = { meaning: "launchSignups", grain: "total", launchId: launch.id };
        } else {
          // On a chart slide with no chart yet, sign-ups come week by week.
          const weekly = op.meaning === "waitlistSignups" && s.layout === "chart" && !s.blocks.some((b) => b.series?.length);
          req = { meaning: op.meaning, grain: weekly ? "week" : "total", weeks: op.weeks ?? 12 };
        }
        const f = await fillBlock(reader, req);
        if (f.block.value === null) {
          warnings.push(CHANGE_WARNINGS.noData(op.slide, BLOCK_SHORT[op.meaning]));
          if (f.need) update(id, (x) => ({ ...x, needs: withNeed(x.needs, f.need!) }));
          break;
        }
        const blocks = [...s.blocks, f.block];
        update(id, (x) => ({ ...x, blocks, needs: settledNeeds(x.section, blocks, x.needs) }));
        if (LAYOUTS[s.layout].blocks === 0) warnings.push(CHANGE_WARNINGS.layoutHidesNumbers(op.slide));
        break;
      }
      case "refresh_numbers":
        refresh = true;
        break;
    }
  }
  if (issues.length) return fail(422, "invalid_ops", { issues });

  // Text changes: one model call for all of them.
  let sources: PackLine[] | undefined;
  /** Whether a slide took the model's words, so the version is something raise_write made. */
  let wrote = false;
  if (tasks.length) {
    const tenant = (await tenantOnce()) ?? null;
    const fresh = await raiseContext(ctx, { audience: doc.audience, stage: doc.stage }, { db: deps.db, loadTenant: async () => tenant, ...deps.pack, reader });
    const merged = mergeLines(doc.sources, fresh.lines);
    if (merged.sources.length > doc.sources.length) sources = merged.sources;
    const c: TextCtx = { outline: outlineFor(doc.audience, doc.stage), pack: { ...fresh, lines: merged.lines }, reader, now, stage: doc.stage };

    const generate = deps.generate ?? generateJsonWithSchema;
    const raw = await generate(revisePrompt(doc, work, tasks, c.pack, now), {
      schema: reviseSchema(),
      timeoutMs: REVISE_TIMEOUT_MS,
      temperature: 0.4,
      thinkingBudget: THINKING,
      usage: aiUsage(ctx, "raise_write", { db: deps.db, tenant }),
    }).catch(() => null);
    const answer = raw ? answerOf(parseFirstJson(raw)) : null;
    // A rewrite with no answer at all saves nothing; a new slide falls back to its outline.
    if (!answer && tasks.some((t) => t.kind !== "new")) return fail(502, "revise_failed");

    for (const t of tasks) {
      const m = answer?.get(t.ref);
      const n = at(t.id) + 1;
      const s = work[n - 1]!;
      if (t.kind === "new") {
        const made = m
          ? await buildSlide(m, { section: t.section!, n, layout: t.layout, prompt: REVISE_PROMPT_TAG }, c, warnings)
          : (warnings.push(CHANGE_WARNINGS.addOutline(n)), await outlineSlide(t.section!, c, doc.title, warnings, t.layout));
        work[n - 1] = { ...made, id: t.id };
        if (m) wrote = true;
      } else if (t.kind === "rewrite") {
        if (m) {
          work[n - 1] = await rewritten(s, m, n, c, warnings);
          wrote = true;
        } else warnings.push(CHANGE_WARNINGS.notRewritten(n));
      } else {
        const next = m ? withNotes(s, m, c) : null;
        if (next) {
          work[n - 1] = next;
          wrote = true;
        } else warnings.push(CHANGE_WARNINGS.emptyNotes(n));
      }
    }
  }

  let changed: NumberChange[] = [];
  let slides = work;
  if (refresh) {
    const r = await refreshBlocks(reader, work);
    slides = r.slides;
    changed = r.changed;
  }

  const note =
    clip(input.note, L.note) || (onlyRefresh(input.ops) && changed.length ? NOTE_WORDS.refreshed(changed.map((x) => `slide ${x.slideN} ${x.name} ${x.from} to ${x.to}`)) : undefined);
  // What made the words (LOOPS_ENABLED, learning loops step 5): raise_write by Vizzy, read where
  // the version is saved. Only a version with the model's words counts made, once as it is saved:
  // a move, a layout, a number or a refresh is code, and a version saved over nothing counts none.
  const made = wrote ? (await learnedFor(ctx, "raise_write", { promptId: REVISE_PROMPT.id, by: "vizzy" }, { now })).stamp : null;
  const saved = await saveRaiseVersion(ctx, doc.id, { baseVersion: input.baseVersion, title: doc.title, slides, note, by: "vizzy", keepAi: false, ...(sources ? { sources } : {}) }, deps);
  if (!saved.ok) return saved;
  if (made && saved.value.saved) await countMade(ctx, "raise_write", made, { type: "raise_doc", db: deps.db, now });
  return { ok: true, value: { doc: saved.value.doc, saved: saved.value.saved, warnings: [...new Set(warnings)], changed } };
}
