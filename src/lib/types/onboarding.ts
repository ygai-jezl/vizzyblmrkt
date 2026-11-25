import { z } from "zod";
import { FACT_KINDS, type FactKind } from "@/lib/onboarding/choices";
import { PROFILE_CHOICES, PROFILE_KEYS, type ProfileKey } from "./businessProfile";

/**
 * What a brand's admins said to Vizzy and what Vizzy kept from it (ONBOARDING_ENABLED), in the
 * brand's own region through forTenant(ctx):
 *
 * - `onboarding_conversations/{oc_<32 hex>}`: one conversation, kept as words only (never audio),
 *   with what Vizzy learned from it waiting for an admin's "Looks right".
 * - `business_facts/{bf_<16 hex>}`: one thing Vizzy heard and an admin kept, with the member's own
 *   words. Removing one deletes it: the words go.
 *
 * Every word in them is a person's own and untrusted: fenced as data in any prompt, never logged.
 * The four answers are on the brand record (./businessProfile.ts), not here.
 */

export const ONBOARDING_LIMITS = {
  /** Turns kept per conversation (the waitlist voice transcript keeps as many). */
  MAX_TURNS: 200,
  MAX_TURN_TEXT: 2_000,
  /** Characters kept per conversation: a 6 minute call is about 11,000. */
  MAX_CHARS: 40_000,
  /** Turns in one upload from the browser. */
  TURNS_PER_APPEND: 20,
  /** Notes Vizzy took during a call (hints for learning only). */
  MAX_NOTES: 20,
  /** Conversations kept per brand: read whole and sorted in code, so no index is needed. */
  MAX_CONVERSATIONS: 20,
  /** How long a call may add words: the 6 minute token plus 2 minutes to send the rest. */
  LIVE_WINDOW_MS: 8 * 60_000,
  /** The most seconds a call counts in the usage meter: its token's whole life (src/lib/onboarding/voice/config.ts). */
  MAX_CALL_SEC: 360,
  /** Tries at learning from one conversation. */
  MAX_LEARN_TRIES: 3,
  /** Facts learned from one conversation (ids f0 to f7). */
  MAX_FACTS_LEARNED: 8,
  /** Facts kept per brand. */
  MAX_FACTS: 40,
  MIN_FACT_TEXT: 3,
  MAX_FACT_TEXT: 80,
  MIN_QUOTE: 8,
  MAX_QUOTE: 300,
  /** Seconds from the start a turn may claim. */
  MAX_AT_SEC: 900,
  /** An upload's whole body, under the browser's 64 kB limit for a request sent as the page closes. */
  MAX_BODY_BYTES: 60_000,
} as const;

export const CONVERSATION_ID_RE = /^oc_[a-f0-9]{32}$/;
export const FACT_ID_RE = /^bf_[a-f0-9]{16}$/;
/** A learned fact's id within its conversation, in the order Vizzy gave them. */
export const LEARNED_FACT_ID_RE = /^f[0-7]$/;

export const isConversationId = (id: unknown): id is string => typeof id === "string" && CONVERSATION_ID_RE.test(id);
export const isFactId = (id: unknown): id is string => typeof id === "string" && FACT_ID_RE.test(id);

export const ConversationSource = z.enum(["voice", "chat"]);
export type ConversationSource = z.infer<typeof ConversationSource>;

/** Why a call ended: the person, the clock, Vizzy, a closed page or an error. */
export const EndReason = z.enum(["person", "time", "vizzy", "closed", "error"]);
export type EndReason = z.infer<typeof EndReason>;

/** The four answers are also the topics Vizzy makes sure a call covers. */
export const TOPIC_KEYS = PROFILE_KEYS;
export type TopicKey = ProfileKey;

/** One line of a conversation, as the browser sends it. */
export const VoiceTurnSchema = z
  .object({
    who: z.enum(["member", "vizzy"]),
    text: z.string().trim().min(1).max(ONBOARDING_LIMITS.MAX_TURN_TEXT),
    atSec: z.number().int().min(0).max(ONBOARDING_LIMITS.MAX_AT_SEC),
  })
  .strict();
export type VoiceTurn = z.infer<typeof VoiceTurnSchema>;

/** What Vizzy noted for a topic during a call: one of its choices, or "unclear". A hint, never the truth. */
export const VoiceNoteSchema = z
  .object({
    topic: z.enum(PROFILE_KEYS),
    choice: z.string().max(24),
    words: z.string().trim().max(ONBOARDING_LIMITS.MAX_QUOTE).optional(),
  })
  .strict()
  .refine((n) => n.choice === "unclear" || (PROFILE_CHOICES[n.topic] as readonly string[]).includes(n.choice), {
    message: "a choice of that topic, or unclear",
    path: ["choice"],
  });
export type VoiceNote = z.infer<typeof VoiceNoteSchema>;

/** A turn as kept: its text on one line. */
export interface ConversationTurn {
  who: "member" | "vizzy";
  text: string;
  atSec: number;
}

/** A note as kept, stamped when it arrived. */
export interface ConversationNote {
  topic: TopicKey;
  choice: string;
  words?: string;
  at: string;
}

export interface LearnedAnswer {
  /** One of the question's choices, or null when the member didn't say it clearly. */
  value: string | null;
  /** The member's words it rests on, or for a blank the words that left it unclear, or "". */
  words: string;
}

export interface LearnedFact {
  /** "f0" to "f7", in the order Vizzy gave them. */
  id: string;
  kind: FactKind;
  text: string;
  /** The member's own words, found inside one of their turns. */
  quote: string;
}

/** What Vizzy learned from a conversation, checked against the member's own words. */
export interface Learned {
  answers: Record<ProfileKey, LearnedAnswer>;
  facts: LearnedFact[];
  model: string;
  at: string;
}

/** onboarding_conversations/{oc_<32 hex>} (regional). */
export interface OnboardingConversation {
  id: string;
  tenantId: string;
  source: ConversationSource;
  /** The member who spoke: their user id only, never a name or an address. Only they add words. */
  by: string;
  status: "live" | "ended";
  startedAt: string;
  /** Words are taken until then. */
  expiresAt: string;
  endedAt: string | null;
  endReason?: EndReason;
  lengthSec: number;
  model: string;
  turns: ConversationTurn[];
  chars: number;
  notes: ConversationNote[];
  /** Waiting for "Looks right"; null until learning worked. */
  learned: Learned | null;
  learnTries: number;
  confirmedAt: string | null;
  /** Seconds of the call already counted in the usage meter. */
  meteredSeconds: number;
  createdAt: string;
}

/** business_facts/{bf_<16 hex>} (regional). */
export interface BusinessFact {
  id: string;
  tenantId: string;
  kind: FactKind;
  /** 3 to 80 characters, in house style. */
  text: string;
  /** 8 to 300 characters: the member's own words. */
  quote: string;
  source: ConversationSource;
  /** The conversation it came from. It may be deleted since: the fact stays until removed. */
  conversationId: string | null;
  /** When it was said (the conversation's start), for "From our call, 25 Nov". */
  heardAt: string;
  confirmedAt: string;
  createdAt: string;
}

/** A conversation for a list: no words. */
export interface ConversationSummary {
  id: string;
  source: ConversationSource;
  status: "live" | "ended";
  startedAt: string;
  endedAt: string | null;
  lengthSec: number;
  turnCount: number;
  /** Learned and not yet confirmed. */
  waiting: boolean;
}

// ---- Reading what was learned back -------------------------------------------------------------

const StoredAnswer = z
  .object({ value: z.string().nullable().catch(null), words: z.string().max(ONBOARDING_LIMITS.MAX_QUOTE).catch("") })
  .catch({ value: null, words: "" });

const StoredFact = z.object({
  id: z.string().regex(LEARNED_FACT_ID_RE),
  kind: z.enum(FACT_KINDS),
  text: z.string().min(1).max(ONBOARDING_LIMITS.MAX_FACT_TEXT),
  quote: z.string().min(1).max(ONBOARDING_LIMITS.MAX_QUOTE),
});

const BLANK_ANSWER: LearnedAnswer = { value: null, words: "" };

/**
 * A stored `learned`, as a screen may show it: an answer that isn't one of its choices reads as
 * blank, and a damaged fact is left out on its own. Null when there is nothing usable.
 */
export function readLearned(raw: unknown): Learned | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const answersRaw = (r.answers && typeof r.answers === "object" ? r.answers : {}) as Record<string, unknown>;
  const answers = Object.fromEntries(
    PROFILE_KEYS.map((key) => {
      const a = StoredAnswer.parse(answersRaw[key] ?? BLANK_ANSWER);
      const value = a.value !== null && (PROFILE_CHOICES[key] as readonly string[]).includes(a.value) ? a.value : null;
      return [key, { value, words: a.words }];
    }),
  ) as Record<ProfileKey, LearnedAnswer>;
  const facts: LearnedFact[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(r.facts) ? r.facts.slice(0, ONBOARDING_LIMITS.MAX_FACTS_LEARNED) : []) {
    const parsed = StoredFact.safeParse(f);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    facts.push(parsed.data);
  }
  return {
    answers,
    facts,
    model: typeof r.model === "string" ? r.model : "",
    at: typeof r.at === "string" ? r.at : "",
  };
}
