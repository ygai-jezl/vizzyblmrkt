import { PROFILE_CHOICES, PROFILE_KEYS, type ProfileAnswers, type ProfileAnswersInput, type ProfileKey } from "@/lib/types/businessProfile";
import type { ConversationSource, LearnedAnswer, LearnedFact } from "@/lib/types/onboarding";
import { LEARNED_WORDS, messageCount, shortDate, shortLength } from "./words";

/**
 * Here's what I learned, as the screen holds it: every change stays on the page until "Looks
 * right" sends it once. Pure and client safe, so it is tested without a browser.
 */

const isChoice = (key: ProfileKey, value: string | null | undefined): value is string =>
  !!value && (PROFILE_CHOICES[key] as readonly string[]).includes(value);

/**
 * The answers the page starts with: what Vizzy learned, else what the brand already said (so a
 * second call never blanks an answer), else nothing (the row asks).
 */
export function initialAnswers(learned: Record<ProfileKey, LearnedAnswer>, saved: ProfileAnswers): ProfileAnswers {
  const out: Record<string, string> = {};
  for (const key of PROFILE_KEYS) {
    const value = isChoice(key, learned[key]?.value) ? learned[key].value : saved[key];
    if (isChoice(key, value)) out[key] = value;
  }
  return out as ProfileAnswers;
}

/** The member's words that left each blank answer unclear, for "I couldn't tell from ...". */
export function unclearWords(learned: Record<ProfileKey, LearnedAnswer>): Partial<Record<ProfileKey, string>> {
  const out: Partial<Record<ProfileKey, string>> = {};
  for (const key of PROFILE_KEYS) {
    const a = learned[key];
    if (a && !isChoice(key, a.value) && a.words.trim()) out[key] = a.words.trim();
  }
  return out;
}

/** Removals as a stack, so Undo brings back the last one. */
export function removeFact(removed: readonly string[], id: string): string[] {
  return removed.includes(id) ? [...removed] : [...removed, id];
}
export function undoRemove(removed: readonly string[]): string[] {
  return removed.slice(0, -1);
}

/** "Removed: {fact}" for the last removal, or null when nothing is removed. */
export function removedNote(facts: readonly LearnedFact[], removed: readonly string[]): string | null {
  const last = removed[removed.length - 1];
  const fact = last ? facts.find((f) => f.id === last) : undefined;
  return fact ? LEARNED_WORDS.removed(fact.text) : null;
}

/** What "Looks right" sends: the answers on the page and the facts still listed, by id only. */
export function confirmBody(answers: ProfileAnswers, facts: readonly LearnedFact[], removed: readonly string[]): { answers: ProfileAnswersInput; keep: string[] } {
  const picked: Record<string, string> = {};
  for (const key of PROFILE_KEYS) {
    const value = answers[key];
    if (isChoice(key, value)) picked[key] = value;
  }
  return { answers: picked as ProfileAnswersInput, keep: facts.filter((f) => !removed.includes(f.id)).map((f) => f.id) };
}

/** "From our call, 4 min, 25 Nov" or "From our chat, 11 messages, 25 Nov". */
export function learnedSource(c: { source: ConversationSource; startedAt: string; lengthSec: number; turnCount: number }, now?: number): string {
  const date = shortDate(c.startedAt, now);
  return c.source === "chat" ? LEARNED_WORDS.fromChat(messageCount(c.turnCount), date) : LEARNED_WORDS.fromCall(shortLength(c.lengthSec), date);
}
