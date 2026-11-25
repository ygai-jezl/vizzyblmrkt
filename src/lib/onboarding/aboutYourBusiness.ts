import type { FactKind } from "./choices";
import type { WaitingFact } from "./factSuggestions";
import { ABOUT_WORDS, FACT_WORDS, SUGGESTION_WORDS, TRANSCRIPT_WORDS, longLength, messageCount, shortDate } from "./words";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import type { BusinessFact, ConversationSource, ConversationSummary, OnboardingConversation } from "@/lib/types/onboarding";

/**
 * Settings, About your business, as plain data: what the page sends the browser (no ids of
 * people, no brand id) and the words each row shows. Client safe and pure, so a test reads it
 * without a browser.
 */

/** A kept fact, as the section lists it. */
export interface AboutFact {
  id: string;
  kind: FactKind;
  text: string;
  quote: string;
  source: ConversationSource;
  heardAt: string;
}

/** A kept conversation, as the section lists it: no words (they load when it opens). */
export interface AboutConversation {
  id: string;
  source: ConversationSource;
  startedAt: string;
  lengthSec: number;
  turnCount: number;
}

/** Something Vizzy heard in a later chat, waiting for an admin to keep or remove it. */
export interface AboutWaiting {
  /** The suggestion's id (an agent action's). */
  id: string;
  kind: FactKind;
  text: string;
  quote: string;
  /** When Vizzy heard it. */
  at: string;
}

export function aboutWaiting(list: readonly WaitingFact[]): AboutWaiting[] {
  return list.map((w) => ({ id: w.id, kind: w.kind, text: w.text, quote: w.quote, at: w.at }));
}

/** "From a chat, 25 Nov. Waiting for you". */
export function waitingSource(w: Pick<AboutWaiting, "at">, now?: number): string {
  return SUGGESTION_WORDS.waiting(shortDate(w.at, now));
}

/** What Keep or Remove on a waiting row answered, as the section says it. Null: it worked. */
export function decisionProblem(res: { ok: boolean; status: number; error?: string } | null, decision: "keep" | "remove"): { text: string; drop: boolean } | null {
  if (res?.ok) return null;
  if (res && (res.status === 404 || res.error === "already_decided")) return { text: SUGGESTION_WORDS.decided, drop: true };
  if (res?.error === "too_many_facts") return { text: SUGGESTION_WORDS.full, drop: false };
  return { text: decision === "keep" ? SUGGESTION_WORDS.notKept : ABOUT_WORDS.notRemoved, drop: false };
}

/** A conversation just kept goes in its place in the table: newest first. */
export function withConversation(list: readonly AboutConversation[], c: AboutConversation): AboutConversation[] {
  return [...list.filter((x) => x.id !== c.id), c].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}

export function aboutFacts(facts: readonly BusinessFact[]): AboutFact[] {
  return facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text, quote: f.quote, source: f.source, heardAt: f.heardAt }));
}

export function aboutConversations(list: readonly ConversationSummary[]): AboutConversation[] {
  return list.map((c) => ({ id: c.id, source: c.source, startedAt: c.startedAt, lengthSec: c.lengthSec, turnCount: c.turnCount }));
}

/** One conversation just kept (a chat's lines, when an admin keeps what Vizzy heard), as the table lists it. */
export function aboutConversation(c: Pick<OnboardingConversation, "id" | "source" | "startedAt" | "lengthSec" | "turns">): AboutConversation {
  return { id: c.id, source: c.source, startedAt: c.startedAt, lengthSec: c.lengthSec, turnCount: c.turns.length };
}

/** "From our call, 25 Nov" or "From a chat, 25 Nov". */
export function factSource(f: Pick<AboutFact, "source" | "heardAt">, now?: number): string {
  const date = shortDate(f.heardAt, now);
  return f.source === "chat" ? FACT_WORDS.fromChat(date) : FACT_WORDS.fromCall(date);
}

/** One row of the Conversations table. */
export function conversationRow(c: AboutConversation, now?: number) {
  const what = c.source === "chat" ? ("chat" as const) : ("call" as const);
  const date = shortDate(c.startedAt, now);
  return {
    what,
    name: what === "chat" ? TRANSCRIPT_WORDS.chat : TRANSCRIPT_WORDS.call,
    date,
    length: what === "chat" ? messageCount(c.turnCount) : longLength(c.lengthSec),
    viewAria: ABOUT_WORDS.viewAria(what, date),
    deleteAria: ABOUT_WORDS.deleteAria(what, date),
  };
}

/**
 * What Vizzy learned, when it is empty, says how to add to it only where that can be done here:
 * Talk with Vizzy while it is offered, a chat while the section can change, else nothing.
 */
export function noFactsLine(opts: { voice: boolean; editable: boolean }): string {
  if (!opts.editable) return ABOUT_WORDS.noFactsReadOnly;
  return opts.voice ? ABOUT_WORDS.noFacts : ABOUT_WORDS.noFactsChat;
}

/** "Talk with Vizzy again" once a call is kept, else "Talk with Vizzy". */
export function talkLabel(conversations: readonly Pick<AboutConversation, "source">[]): string {
  return conversations.some((c) => c.source === "voice") ? ABOUT_WORDS.talkAgain : ABOUT_WORDS.talk;
}

/** A pick that didn't save goes back to what it was, unless a later pick has changed it since. */
export function undoPick(answers: ProfileAnswers, key: ProfileKey, picked: string, before: string | undefined): ProfileAnswers {
  if (answers[key] !== picked) return answers;
  const next: Record<string, string | undefined> = { ...answers };
  if (before === undefined) delete next[key];
  else next[key] = before;
  return next as ProfileAnswers;
}

/** A remove or delete that worked, or found it already gone (another admin, another tab). */
export function isGone(res: { ok: boolean; status: number } | null): boolean {
  return !!res && (res.ok || res.status === 404);
}
