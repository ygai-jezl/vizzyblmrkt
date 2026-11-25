import { z } from "zod";
import { generateTextWithDeadline, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { aiTellsIn } from "@/lib/content/writingRules";
import { PROFILE_CHOICES, PROFILE_KEYS, type ProfileKey } from "@/lib/types/businessProfile";
import {
  ONBOARDING_LIMITS,
  type ConversationNote,
  type ConversationTurn,
  type Learned,
  type LearnedAnswer,
  type LearnedFact,
} from "@/lib/types/onboarding";
import { FACT_KINDS, type FactKind } from "./choices";

/**
 * What Vizzy learned from a conversation with a brand's admin (ONBOARDING_ENABLED): the four
 * answers and up to 8 other facts, each resting on the member's own words.
 *
 * One model call in JSON mode, then zod and code checks, failing closed: an answer or a fact
 * survives only when its words are inside ONE member turn (ignoring case, spacing and punctuation,
 * since speech to text punctuates unevenly). Vizzy's own lines never count. Anything unusable
 * becomes a blank. The member's words are untrusted: fenced as data in the prompt, never logged.
 * No member turns, no call.
 */

/** Reading needs no thinking, and none keeps the founder's wait short (the competitor articles measure). */
const THINKING = 0;
/** The whole read, while the founder waits on the Ended screen. */
const TIMEOUT_MS = 22_000;
/** Kept back for a second try when the first gives nothing. */
const RETRY_MS = 8_000;

/** Fences in the prompt: a turn or a note can't close one early. */
const FENCE_TAGS = /<\/?\s*(conversation|notes)\b[^>]*>/gi;

/** One line of text: every run of spacing (line breaks too) becomes a space, so a turn can't start a fake line. */
const oneLine = (s: string) => s.replace(/[\s\u0085]+/g, " ").trim();

/** Someone's words, safe inside our fences. */
const fencedWords = (s: string) => oneLine(s.replace(FENCE_TAGS, " "));

/** The conversation for the prompt: "MEMBER: ..." and "VIZZY: ..." one line per turn. */
export function conversationForPrompt(turns: readonly ConversationTurn[]): string {
  return turns
    .map((t) => ({ who: t.who === "member" ? "MEMBER" : "VIZZY", text: fencedWords(t.text) }))
    .filter((t) => t.text)
    .map((t) => `${t.who}: ${t.text}`)
    .join("\n");
}

/** Vizzy's notes from the call, as hints for the prompt (the latest per topic), or "none". */
export function notesForPrompt(notes: readonly Pick<ConversationNote, "topic" | "choice" | "words">[]): string {
  const latest = new Map<ProfileKey, Pick<ConversationNote, "choice" | "words">>();
  for (const n of notes) if ((PROFILE_KEYS as readonly string[]).includes(n.topic)) latest.set(n.topic, n);
  const lines = PROFILE_KEYS.flatMap((key) => {
    const n = latest.get(key);
    if (!n) return [];
    const words = n.words ? fencedWords(n.words).replace(/"/g, "'") : "";
    return [`${key}: ${fencedWords(n.choice)}${words ? ` ("${words}")` : ""}`];
  });
  return lines.length ? lines.join("\n") : "none";
}

/**
 * Words as compared: one form of each character, lower case, every apostrophe dropped (so "it's"
 * and "its", or a quote in single quotes, compare alike), and every run of anything that is not a
 * letter or a digit made one space.
 */
export function quoteKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ`´′]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether `quote` is inside ONE of the member's turns, as whole words, ignoring case, spacing and
 * punctuation. Never stitched across turns. False when its words are shorter than `min`.
 */
export function quoteIn(memberTurns: readonly string[], quote: string, min: number): boolean {
  const key = quoteKey(quote);
  if (key.length < Math.max(1, min)) return false;
  return memberTurns.some((t) => ` ${quoteKey(t)} `.includes(` ${key} `));
}

/** Four blanks and no facts. */
export function blankLearned(model: string, at: string): Learned {
  const answers = Object.fromEntries(PROFILE_KEYS.map((k) => [k, { value: null, words: "" }])) as Record<ProfileKey, LearnedAnswer>;
  return { answers, facts: [], model, at };
}

// ---- Checking the model's answer ----------------------------------------------------------------

/** Lenient per item, so one bad item never drops the rest. */
const RawAnswer = z
  .object({ value: z.string().nullable().catch(null), words: z.string().max(600).catch("") })
  .catch({ value: null, words: "" });
const RawFact = z.object({ kind: z.string(), text: z.string(), quote: z.string() });
const RawLearned = z
  .object({
    answers: z.object({ who: RawAnswer, run: RawAnswer, stage: RawAnswer, want: RawAnswer }).partial().catch({}),
    facts: z.array(z.unknown()).max(30).catch([]),
  })
  .catch({ answers: {}, facts: [] });

/** House style for a fact's line: a dash used as punctuation becomes a comma, quote marks go, one line. */
function tidyText(text: string): string {
  return oneLine(text)
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/(?<=\S) - (?=\S)/g, ", ")
    .replace(/["“”„«»]/g, "")
    .replace(/^[,;:\s'‘’]+|[,;:\s'‘’]+$/g, "")
    .trim();
}

/** Cut at a word to `max` characters, without a dangling comma. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : text.slice(0, max)).replace(/[,;:\s]+$/, "").trim();
}

/** A fact's line in house style, cut at a word to 80 characters (Vizzy's chat suggestions too). */
export function tidyFactText(text: string): string {
  return cutAtWord(tidyText(text), ONBOARDING_LIMITS.MAX_FACT_TEXT);
}

/** A fact's kind, as the prompt names them (an older spelling of "start" is taken too). */
function kindOf(raw: string): FactKind | null {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (k === "starting_point") return "start";
  return (FACT_KINDS as readonly string[]).includes(k) ? (k as FactKind) : null;
}

/**
 * The model's answer, checked against the member's own turns. Pure, and fails closed: an answer
 * needs one of its choices AND its words inside one member turn; a fact needs a known kind, a
 * short line with no AI tell, and a quote of 8 to 300 characters inside one member turn. A blank
 * keeps the words that left it unclear only when they are the member's. Unusable output gives four
 * blanks and no facts.
 */
export function checkLearned(raw: unknown, turns: readonly ConversationTurn[], model: string, at: string): Learned {
  const L = ONBOARDING_LIMITS;
  const member = turns.filter((t) => t.who === "member").map((t) => t.text);
  const r = RawLearned.parse(raw ?? null);
  const out = blankLearned(model, at);

  for (const key of PROFILE_KEYS) {
    const a = r.answers[key];
    if (!a) continue;
    const words = oneLine(a.words);
    const choice = a.value !== null && (PROFILE_CHOICES[key] as readonly string[]).includes(a.value) ? a.value : null;
    if (choice && words.length <= L.MAX_QUOTE && quoteIn(member, words, 2)) out.answers[key] = { value: choice, words };
    else out.answers[key] = { value: null, words: words.length <= L.MAX_QUOTE && quoteIn(member, words, L.MIN_QUOTE) ? words : "" };
  }

  const seen = new Set<string>();
  const facts: LearnedFact[] = [];
  for (const item of r.facts) {
    if (facts.length >= L.MAX_FACTS_LEARNED) break;
    const f = RawFact.safeParse(item);
    if (!f.success) continue;
    const kind = kindOf(f.data.kind);
    if (!kind) continue;
    const text = cutAtWord(tidyText(f.data.text), L.MAX_FACT_TEXT);
    if (text.length < L.MIN_FACT_TEXT || aiTellsIn(text).length) continue;
    const quote = oneLine(f.data.quote);
    if (quote.length < L.MIN_QUOTE || quote.length > L.MAX_QUOTE || !quoteIn(member, quote, L.MIN_QUOTE)) continue;
    const keys = [`q:${quoteKey(quote)}`, `t:${quoteKey(text)}`];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    facts.push({ id: `f${facts.length}`, kind, text, quote });
  }
  out.facts = facts;
  return out;
}

// ---- The call ----------------------------------------------------------------------------------

export interface LearnInput {
  turns: readonly ConversationTurn[];
  /** Vizzy's notes from the call: hints only. */
  notes?: readonly Pick<ConversationNote, "topic" | "choice" | "words">[];
  brandName: string;
}

export interface LearnDeps {
  generate?: (
    prompt: string,
    opts: { timeoutMs: number; json: boolean; temperature: number; thinkingBudget: number; usage: AiUsage },
  ) => Promise<string | null>;
  /** Milliseconds now (tests). */
  clock?: () => number;
}

/** The brand's name for the prompt's first line: plain, short, with nothing that could open a fence. */
function brandForPrompt(name: string): string {
  return oneLine(name.replace(/[<>"]/g, " ")).slice(0, 80) || "this brand";
}

/**
 * Learn from a conversation. With no member turns there is nothing to learn: four blanks, and no
 * call. Null only when the model gave nothing, both tries (the caller may try again later).
 * Every call is counted through `usage` (aiUsage(ctx, "onboarding")).
 */
export async function learnFromConversation(input: LearnInput, usage: AiUsage, deps: LearnDeps = {}): Promise<Learned | null> {
  const clock = deps.clock ?? Date.now;
  const at = () => new Date(clock()).toISOString();
  if (!input.turns.some((t) => t.who === "member" && t.text.trim())) return blankLearned(TEXT_MODEL, at());

  const prompt = renderPrompt("onboarding.learn", {
    brand_name: brandForPrompt(input.brandName),
    notes: notesForPrompt(input.notes ?? []),
    conversation: conversationForPrompt(input.turns),
  });
  const generate = deps.generate ?? generateTextWithDeadline;
  const end = clock() + TIMEOUT_MS;
  const opts = (timeoutMs: number) => ({ timeoutMs, json: true, temperature: 0, thinkingBudget: THINKING, usage });
  let raw = await generate(prompt, opts(Math.max(1, end - clock() - RETRY_MS)));
  // A slow or empty answer: once more, while there's time.
  if (!raw && end - clock() >= RETRY_MS) raw = await generate(prompt, opts(end - clock()));
  if (!raw) return null;
  return checkLearned(parseFirstJson(raw), input.turns, TEXT_MODEL, at());
}
