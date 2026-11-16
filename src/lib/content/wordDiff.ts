/**
 * A word level diff of two short texts (a post as Vizzy wrote it, and as it was posted), keeping
 * each word's own spacing and line breaks so the result reads like the post. Pure.
 */

export type DiffOp = "same" | "del" | "ins";
export interface DiffSegment {
  op: DiffOp;
  text: string;
}

/** Above this many word pairs the diff isn't worked out word by word (one removal, one insertion). */
const MAX_CELLS = 400_000;

/** Words with the spacing after each, plus any spacing before the first. */
function tokens(text: string): { lead: string; words: string[] } {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  return { lead, words: text.slice(lead.length).match(/\S+\s*/g) ?? [] };
}

const key = (w: string) => w.trimEnd();

function push(out: DiffSegment[], op: DiffOp, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

/** The segments that turn `before` into `after`, in order. Same words carry `after`'s spacing. */
export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokens(before);
  const b = tokens(after);
  const out: DiffSegment[] = [];
  push(out, "same", b.lead);
  const n = a.words.length;
  const m = b.words.length;
  if (n * m > MAX_CELLS) {
    push(out, "del", a.words.join(""));
    push(out, "ins", b.words.join(""));
    return out;
  }
  // Longest common subsequence of words, compared without their trailing spacing.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = key(a.words[i]!) === key(b.words[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && key(a.words[i]!) === key(b.words[j]!)) {
      push(out, "same", b.words[j]!);
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      push(out, "del", a.words[i]!);
      i += 1;
    } else {
      push(out, "ins", b.words[j]!);
      j += 1;
    }
  }
  return out;
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The runs of words taken out and put in, in order, each run joined by single spaces. */
export function changeRuns(segments: readonly DiffSegment[]): { removed: string; added: string }[] {
  const runs: { removed: string; added: string }[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length || added.length) runs.push({ removed: removed.join(" "), added: added.join(" ") });
    removed = [];
    added = [];
  };
  for (const s of segments) {
    if (s.op === "same") {
      if (s.text.trim()) flush();
      continue;
    }
    const words = s.text.split(/\s+/).filter(Boolean);
    (s.op === "del" ? removed : added).push(...words);
  }
  flush();
  return runs.map((r) => ({ removed: r.removed, added: r.added }));
}

/** How many words a person changed: for each run, the larger of the words taken out and put in. */
export function wordsChanged(segments: readonly DiffSegment[]): number {
  return changeRuns(segments).reduce((sum, r) => sum + Math.max(countWords(r.removed), countWords(r.added)), 0);
}
