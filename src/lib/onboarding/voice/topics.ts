import { PROFILE_CHOICES, PROFILE_KEYS, type ProfileKey } from "@/lib/types/businessProfile";
import { ONBOARDING_LIMITS, type Learned, type VoiceNote } from "@/lib/types/onboarding";
import { QUESTIONS, answerLabel } from "../choices";

/**
 * The four topics during and after a call: which Vizzy noted (its silent note_answer calls) and
 * which it heard. The notes only tick the topics on screen; what the server learns after the call
 * is the truth. Pure and client safe.
 */

export type TopicState = "done" | "now" | "next";

export interface TopicView {
  key: ProfileKey;
  /** "Who you are". */
  label: string;
  state: TopicState;
  /** The answer's label when done ("A small team"), else "". */
  answer: string;
}

type NoteLike = Pick<VoiceNote, "topic" | "choice">;

/**
 * A note_answer call's arguments as a note, or null when they aren't one: a known topic, one of
 * its choices or "unclear", and their words cut to fit.
 */
export function validNote(args: unknown): VoiceNote | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const topic = typeof a.topic === "string" ? a.topic.trim().toLowerCase() : "";
  if (!(PROFILE_KEYS as readonly string[]).includes(topic)) return null;
  const key = topic as ProfileKey;
  const choice = typeof a.choice === "string" ? a.choice.trim().toLowerCase() : "";
  if (choice !== "unclear" && !(PROFILE_CHOICES[key] as readonly string[]).includes(choice)) return null;
  const words = typeof a.words === "string" ? a.words.replace(/\s+/g, " ").trim().slice(0, ONBOARDING_LIMITS.MAX_QUOTE).trim() : "";
  return { topic: key, choice, ...(words ? { words } : {}) };
}

/** The latest note per topic. */
function latest(notes: readonly NoteLike[]): Map<ProfileKey, string> {
  const out = new Map<ProfileKey, string>();
  for (const n of notes) out.set(n.topic, n.choice);
  return out;
}

/** The choice Vizzy noted last for each topic it was sure of ("unclear" left out). */
export function notedAnswers(notes: readonly NoteLike[]): Partial<Record<ProfileKey, string>> {
  const out: Partial<Record<ProfileKey, string>> = {};
  for (const [key, choice] of latest(notes)) if (choice !== "unclear") out[key] = choice;
  return out;
}

/**
 * The four topics on screen during a call: a noted choice is done (the latest note wins), and the
 * first topic with no note at all is the one being talked about now. "unclear" stays to come.
 */
export function topicStates(notes: readonly NoteLike[]): TopicView[] {
  const noted = latest(notes);
  const now = QUESTIONS.find((q) => !noted.has(q.key))?.key;
  return QUESTIONS.map((q) => {
    const choice = noted.get(q.key);
    const answer = choice && choice !== "unclear" ? answerLabel(q.key, choice) : "";
    return { key: q.key, label: q.short, state: answer ? "done" : q.key === now ? "now" : "next", answer };
  });
}

/**
 * What Vizzy heard, for the end of the call: the learned answers when the server learned any,
 * else the notes. In question order.
 */
export function heardAnswers(learned: Pick<Learned, "answers"> | null, notes: readonly NoteLike[]): Partial<Record<ProfileKey, string>> {
  if (learned) {
    const out: Partial<Record<ProfileKey, string>> = {};
    for (const key of PROFILE_KEYS) {
      const value = learned.answers[key]?.value;
      if (value && answerLabel(key, value)) out[key] = value;
    }
    return out;
  }
  return notedAnswers(notes);
}

/** Heard answers as chips, in question order. */
export function heardLabels(heard: Partial<Record<ProfileKey, string>>): Array<{ key: ProfileKey; label: string }> {
  return QUESTIONS.flatMap((q) => {
    const label = answerLabel(q.key, heard[q.key]);
    return label ? [{ key: q.key, label }] : [];
  });
}
