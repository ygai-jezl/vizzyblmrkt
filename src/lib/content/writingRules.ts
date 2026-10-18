/**
 * House style for every piece of copy a person publishes: no dashes as sentence punctuation.
 * Readers now take an em dash as a sign of AI writing ("features—such as tracking").
 */
export const NO_DASHES =
  'Punctuation: never use an em dash (—) or an en dash (–) to join, break or end a sentence, and never a spaced hyphen ( - ) in their place: readers now take them as a sign of AI writing. Use a full stop, a comma, a colon or brackets instead (not "features—such as tracking" but "features, such as tracking"). A hyphen inside a word ("follow-up") or a range ("2024-2026") is fine.';

/**
 * Words and phrases readers now take as signs of AI writing (the owner's comparison of our
 * articles with practitioners', 2026-10-18). The editorial blog writer is told never to use
 * them, and its check names any that slip through (lower case; matched on whole words).
 */
export const AI_TELLS = [
  "in today's",
  "ever-evolving",
  "ever-changing",
  "landscape",
  "delve",
  "deep dive",
  "dive into",
  "navigate the",
  "navigating the",
  "unlock",
  "unleash",
  "empower",
  "elevate",
  "leverage",
  "harness",
  "robust",
  "seamless",
  "seamlessly",
  "cutting-edge",
  "game-changer",
  "game-changing",
  "revolutionize",
  "revolutionary",
  "transformative",
  "supercharge",
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "it is worth noting",
  "in conclusion",
  "in summary",
  "at the end of the day",
  "look no further",
  "take control of",
  "a common scenario",
  "plays a crucial role",
  "plays a pivotal role",
  "pivotal",
  "paramount",
  "furthermore",
  "moreover",
  "in the realm of",
  "tapestry",
  "a testament to",
] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TELL_RES = AI_TELLS.map((tell) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(tell)}(?:$|[^\\p{L}\\p{N}])`, "u"));

/** The AI tells found in some text, each once, in the order of the list. */
export function aiTellsIn(text: string): string[] {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  return AI_TELLS.filter((_, i) => TELL_RES[i]!.test(t));
}

/**
 * Operational writing rules for MODULAR content — so generated blocks recombine
 * across channels without manual editing. Injected into the templatize/transform
 * prompts' "Communication" section (dynamic prompt composition). Pure constant.
 */
export const WRITING_RULES = `Modular writing rules (follow strictly so blocks recombine cleanly):
- Single-Concept: each block covers exactly ONE core idea; omit peripheral details or references to outside themes.
- Non-Linear: never use sequential/positional language ("in the next step", "as shown above", "in section four"). Refer to processes by descriptive NAMES, not numbers.
- Parallel Grammar: write each field in its prescribed pattern:
  · Headings -> a singular noun (e.g. "Integrations").
  · Action items / tasks -> an active verb (e.g. "Configure database").
  · List elements -> consistent noun phrases (e.g. "Scalable database", "Headless engine").
  · Conditional steps -> "If <condition>, <verb> <object>".
  · System feedback -> subject + verb + object (e.g. "The file uploaded successfully").
  · Step instructions -> imperative verb + object (e.g. "Upload the CSV file").
  · Calls-to-action -> a high-value active verb (e.g. "Download the report").
- Voice: avoid empty hyperbole ("revolutionize", "game-changing"); be concrete and specific.
- ${NO_DASHES}`;
