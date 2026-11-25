import type { FactKind } from "./choices";
import { ABOUT_WORDS, FACT_WORDS, TRANSCRIPT_WORDS, longLength, messageCount, shortDate } from "./words";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import type { BusinessFact, ConversationSource, ConversationSummary } from "@/lib/types/onboarding";

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

export function aboutFacts(facts: readonly BusinessFact[]): AboutFact[] {
  return facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text, quote: f.quote, source: f.source, heardAt: f.heardAt }));
}

export function aboutConversations(list: readonly ConversationSummary[]): AboutConversation[] {
  return list.map((c) => ({ id: c.id, source: c.source, startedAt: c.startedAt, lengthSec: c.lengthSec, turnCount: c.turnCount }));
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
