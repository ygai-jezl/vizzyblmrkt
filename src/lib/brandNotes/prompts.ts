import type { BrandNoteKind } from "@/lib/types/brandNote";

/**
 * Help for writing a good note on Brand › What we've seen, all in code (no model call): the
 * question the Add a note box asks, aimed first at the kind the brand has least of and at the
 * subjects nothing covers yet; a kind and subjects suggested from what is typed. Pure +
 * client-safe.
 */

export const KIND_QUESTIONS: Record<BrandNoteKind, string[]> = {
  customer_story: [
    "Which customer's result surprised you most, and what did they do differently?",
    "Tell the story of a customer who nearly left. What changed their mind?",
    "What did a customer do with the product that you never expected?",
  ],
  tested: [
    "What have you tested that didn't work the way people say it does?",
    "What did you try twice because the first result was hard to believe?",
    "Which experiment changed how your team works?",
  ],
  mistake: [
    "What mistake do you see new customers make again and again?",
    "What do people get wrong in their first month?",
    "Which habit costs teams the most without them noticing?",
  ],
  objection: [
    "What do buyers push back on most, and what do you tell them?",
    "Which question on a sales call is hardest to answer honestly?",
    "Why do people say they don't need this yet, and are they right?",
  ],
  numbers: [
    "Which number from your own work would surprise an outsider?",
    "What have you measured that nobody else publishes?",
    "What changed, in numbers, for a customer you can talk about?",
  ],
  before_after: [
    "What did a team's week look like before they changed, and after?",
    "What did you stop doing once you saw the results?",
    "What is different six months after a customer starts?",
  ],
  disagree: [
    "What advice do people in your field give that you think is wrong?",
    "What does everyone in your field say that you don't believe?",
    "Which best practice do you tell customers to ignore?",
  ],
};

/**
 * The question to ask now. Turns alternate between the emptiest kinds and the subjects with no
 * note, so a brand is nudged toward variety and coverage. `turn` moves it on ("Another question").
 */
export function noteQuestion(kinds: Record<BrandNoteKind, number>, uncovered: string[], turn: number): { question: string; kind?: BrandNoteKind; subject?: string } {
  const ordered = (Object.keys(KIND_QUESTIONS) as BrandNoteKind[]).sort((a, b) => (kinds[a] ?? 0) - (kinds[b] ?? 0));
  const useSubject = uncovered.length > 0 && turn % 2 === 1;
  if (useSubject) {
    const subject = uncovered[Math.floor(turn / 2) % uncovered.length]!;
    return { question: `What have you seen first-hand about ${subject}?`, subject };
  }
  const step = useSubject ? 0 : Math.floor(turn / (uncovered.length ? 2 : 1));
  const kind = ordered[step % ordered.length]!;
  const options = KIND_QUESTIONS[kind];
  return { question: options[Math.floor(step / ordered.length) % options.length]!, kind };
}

const KIND_HINTS: Array<[BrandNoteKind, RegExp]> = [
  ["disagree", /\b(disagree|don['’]t believe|do not believe|wrong advice|myth|overrated|ignore the advice|everyone says|people say .* but)\b/i],
  ["tested", /\b(we (?:ran|tried|tested|measured|compared)|experiment|a\/b|test(?:ed|ing)? (?:it|this|that))\b/i],
  ["before_after", /\b(before .* after|used to .* now|went from|after (?:switching|moving|changing))\b/i],
  ["numbers", /(\d+(?:[.,]\d+)?\s*(?:%|per ?cent|x\b|times)|\b\d{2,}\b)/i],
  ["objection", /\b(push(?:es|ed)? back|objection|they ask|buyers ask|asks? why|why can['’]t|why not just|isn['’]t it just)\b/i],
  ["mistake", /\b(mistake|wrong|forget|forgot|miss(?:es|ed)?|never check|only (?:track|look)|get it wrong)\b/i],
];

/** A kind for what is typed, from its words (a person can always change it). */
export function suggestKind(text: string): BrandNoteKind {
  for (const [kind, re] of KIND_HINTS) if (re.test(text)) return kind;
  return "customer_story";
}

const STOP = new Set(
  "about after again against also and any are because been before being both but can could did does doing down each few for from further had has have having here how into its itself just more most much must not now off once only other our out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would your you".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.replace(/(?:ies|es|s)$/, "")),
  );

/** The brand map subjects a note's words point at, best first (at most `max`). */
export function suggestSubjects<T extends { id: string; name: string }>(text: string, subjects: T[], max = 3): T[] {
  const said = words(text);
  if (!said.size) return [];
  return subjects
    .map((s) => {
      const own = [...words(s.name)];
      const shared = own.filter((w) => said.has(w)).length;
      return { s, score: own.length ? shared / own.length : 0 };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.s);
}
