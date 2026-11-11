import { z } from "zod";

/**
 * What Vizzy learns from a person's edits in Edit mode, before it goes to Memory Bank. Each kept
 * or undone change becomes one short line: what they asked, the words that changed and what they
 * did with it. Only the changed words go, never the paragraphs around them, so the article
 * itself isn't sent. Pure.
 */

export const LEARN_LIMITS = { ENTRIES: 20, INSTRUCTION: 1000, TEXT: 280, CHANGED: 200 } as const;

export const LearnEntrySchema = z.object({
  instruction: z.string().trim().min(1).max(LEARN_LIMITS.INSTRUCTION),
  kind: z.enum(["selection", "whole"]),
  outcome: z.enum(["kept", "undone"]),
  before: z.string().max(LEARN_LIMITS.TEXT).default(""),
  after: z.string().max(LEARN_LIMITS.TEXT).default(""),
});
export type LearnEntry = z.infer<typeof LearnEntrySchema>;

export const LearnRequestSchema = z.object({
  entries: z.array(LearnEntrySchema).min(1).max(LEARN_LIMITS.ENTRIES),
});

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** The runs of words taken out and put in, in order (a word level diff). */
export function wordChanges(before: string, after: string): { removed: string[]; added: string[] } {
  const a = words(before);
  const b = words(after);
  // Longest common subsequence of words; both sides are a few dozen words at most.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let out: string[] = [];
  let into: string[] = [];
  const flush = () => {
    if (out.length) removed.push(out.join(" "));
    if (into.length) added.push(into.join(" "));
    out = [];
    into = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      into.push(b[j]!);
      j += 1;
    } else {
      out.push(a[i]!);
      i += 1;
    }
  }
  flush();
  return { removed, added };
}

function quoted(runs: string[]): string {
  let text = runs.map((r) => `"${r}"`).join(", ");
  if (text.length > LEARN_LIMITS.CHANGED) text = `${text.slice(0, LEARN_LIMITS.CHANGED - 3)}...`;
  return text;
}

/** One kept or undone change as a line for Memory Bank, in the person's own voice. */
export function learningEventText(e: LearnEntry): string {
  const where = e.kind === "selection" ? "on text I selected" : "across the whole text";
  const { removed, added } = wordChanges(e.before, e.after);
  const parts: string[] = [];
  if (removed.length && added.length && removed.length === added.length && removed.length <= 3) {
    parts.push(`Vizzy changed ${removed.map((r, k) => `"${r}" to "${added[k]}"`).join(", ")}.`);
  } else {
    if (removed.length) parts.push(`Vizzy took out ${quoted(removed)}.`);
    if (added.length) parts.push(`Vizzy put in ${quoted(added)}.`);
  }
  if (!parts.length) parts.push("Vizzy changed nothing.");
  return `I asked Vizzy, ${where}: "${e.instruction.slice(0, 300)}". ${parts.join(" ")} I ${e.outcome === "kept" ? "kept" : "undid"} the change.`;
}

/** A memory as the panel shows it: "The user keeps intros short." reads "Keeps intros short." */
export function memoryLabel(fact: string): string {
  const t = fact.trim().replace(/^(?:the user|this user|the person|this person)\s+/i, "");
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}
