import { wordDiff, wordsChanged, type DiffSegment } from "@/lib/content/wordDiff";
import { articleLinks, parseArticle } from "@/lib/content/blog/markdown";
import { articleFigures } from "@/lib/content/blog/figures";
import type { EditMeasures } from "@/lib/types/aiOriginal";

/**
 * How a person changed the AI original of a piece before approving it (CONTENT_AI_ORIGINALS_ENABLED).
 * An article is compared section by section (its H2s), matched by heading, so a long article
 * never hits the word diff's size limit and a moved section is not counted as rewritten. A post
 * has no sections and is compared whole. Pure.
 */

/** The word diff gives up past this many word pairs; the same limit as wordDiff.ts. */
const MAX_CELLS = 400_000;
/** At most this many headings are listed as added or cut. */
const MAX_LISTED = 20;

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
const normalHeading = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export interface Section {
  /** "" for what comes before the first H2 (the title and the opening). */
  heading: string;
  text: string;
}

/** The piece split at its H2 headings. A piece with none is one section. */
export function splitSections(markdown: string): Section[] {
  const out: Section[] = [{ heading: "", text: "" }];
  let fence = false;
  for (const line of (markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h2 = !fence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h2 && !/^###/.test(line)) out.push({ heading: h2[1]!.trim(), text: "" });
    else out[out.length - 1]!.text += `${line}\n`;
  }
  return out.filter((s, i) => i > 0 || s.text.trim());
}

/** Words changed between two texts, by paragraph first when they are too long to diff word by word. */
export function changedWords(a: string, b: string): number {
  if (a.trim() === b.trim()) return 0;
  const na = countWords(a);
  const nb = countWords(b);
  if (na * nb <= MAX_CELLS) return wordsChanged(wordDiff(a, b));
  const pa = a.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pb = b.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (pa.length * pb.length > MAX_CELLS) return Math.max(na, nb);
  // Paragraphs kept exactly, by longest common run; only the paragraphs between them are diffed.
  const lcs: Uint32Array[] = Array.from({ length: pa.length + 1 }, () => new Uint32Array(pb.length + 1));
  for (let i = pa.length - 1; i >= 0; i -= 1) {
    for (let j = pb.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = pa[i] === pb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let total = 0;
  let gapA: string[] = [];
  let gapB: string[] = [];
  const flush = () => {
    if (gapA.length || gapB.length) {
      const x = gapA.join("\n\n");
      const y = gapB.join("\n\n");
      total += countWords(x) * countWords(y) <= MAX_CELLS ? wordsChanged(wordDiff(x, y)) : Math.max(countWords(x), countWords(y));
    }
    gapA = [];
    gapB = [];
  };
  let i = 0;
  let j = 0;
  while (i < pa.length || j < pb.length) {
    if (i < pa.length && j < pb.length && pa[i] === pb[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (i < pa.length && (j === pb.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      gapA.push(pa[i]!);
      i += 1;
    } else {
      gapB.push(pb[j]!);
      j += 1;
    }
  }
  flush();
  return total;
}

/** The segments that turn one text into another, or a whole removal and insertion when too long. */
export function diffSegments(a: string, b: string): DiffSegment[] {
  return wordDiff(a, b);
}

export type SectionState = "same" | "changed" | "added" | "cut";

export interface SectionChange {
  heading: string;
  state: SectionState;
  /** Words in the AI original's section (0 for an added one). */
  words: number;
  wordsChanged: number;
  /** The AI original's section and the approved one, for Compare. */
  before: string;
  after: string;
}

/** Each section of either copy, in the approved copy's order, with sections cut placed where they were. */
export function sectionChanges(original: string, final: string): SectionChange[] {
  const a = splitSections(original);
  const b = splitSections(final);
  const used = new Set<number>();
  const byHeading = new Map<string, number[]>();
  a.forEach((s, i) => {
    const k = normalHeading(s.heading);
    byHeading.set(k, [...(byHeading.get(k) ?? []), i]);
  });
  const matchOf = (s: Section): number | null => {
    const list = byHeading.get(normalHeading(s.heading)) ?? [];
    const i = list.find((x) => !used.has(x));
    if (i === undefined) return null;
    used.add(i);
    return i;
  };
  const out: SectionChange[] = [];
  for (const s of b) {
    const i = matchOf(s);
    if (i === null) {
      out.push({ heading: s.heading, state: "added", words: 0, wordsChanged: countWords(s.text), before: "", after: s.text.trim() });
      continue;
    }
    const before = a[i]!.text;
    const changed = changedWords(before, s.text);
    out.push({ heading: s.heading, state: changed ? "changed" : "same", words: countWords(before), wordsChanged: changed, before: before.trim(), after: s.text.trim() });
  }
  a.forEach((s, i) => {
    if (used.has(i)) return;
    // A cut section goes after the section that came before it in the original.
    const prev = a.slice(0, i).reverse().find((p) => out.some((o) => o.state !== "added" && o.heading === p.heading));
    const at = prev ? out.findIndex((o) => o.heading === prev.heading) + 1 : 0;
    out.splice(at, 0, { heading: s.heading, state: "cut", words: countWords(s.text), wordsChanged: countWords(s.text), before: s.text.trim(), after: "" });
  });
  return out;
}

const figuresOf = (text: string) => new Set(articleFigures(text).map((f) => f.display));
const linksOf = (text: string) => new Set(articleLinks(parseArticle(text)).map((l) => l.href));
const only = (x: Set<string>, y: Set<string>) => [...x].filter((v) => !y.has(v)).slice(0, MAX_LISTED);

/** How the approved copy differs from the AI original. */
export function editMeasures(
  original: string,
  final: string,
  opts: { originalAt?: string | null; approvedAt: string; regenerations: number; sections?: boolean },
): EditMeasures {
  const words = countWords(original);
  const sections = opts.sections === false ? null : sectionChanges(original, final);
  const changed = sections ? sections.reduce((sum, s) => sum + s.wordsChanged, 0) : changedWords(original, final);
  const share = words > 0 ? Math.min(1, changed / words) : countWords(final) > 0 ? 1 : 0;
  const figA = figuresOf(original);
  const figB = figuresOf(final);
  const linkA = linksOf(original);
  const linkB = linksOf(final);
  const from = opts.originalAt ? Date.parse(opts.originalAt) : NaN;
  const to = Date.parse(opts.approvedAt);
  return {
    words,
    wordsChanged: changed,
    wordsChangedShare: Math.round(share * 1000) / 1000,
    sectionsAdded: (sections ?? []).filter((s) => s.state === "added" && s.heading).map((s) => s.heading.slice(0, 120)).slice(0, MAX_LISTED),
    sectionsCut: (sections ?? []).filter((s) => s.state === "cut" && s.heading).map((s) => s.heading.slice(0, 120)).slice(0, MAX_LISTED),
    sectionsChanged: (sections ?? []).filter((s) => s.state === "changed").length,
    figuresAdded: only(figB, figA),
    figuresRemoved: only(figA, figB),
    linksAdded: only(linkB, linkA),
    linksCut: only(linkA, linkB),
    minutesToApprove: Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 60_000)) : null,
    regenerations: opts.regenerations,
    approvedAsWritten: changed === 0,
  };
}
