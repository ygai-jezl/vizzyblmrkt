/**
 * The voice chat after a sign-up on a waitlist page: the rules its browser side
 * (src/lib/hooks/useLiveConversation.ts) and its server side
 * (api/waitlist/[campaignId]/conversation/complete) share. Pure and client safe.
 */

/** The complete route's error for a chat in which the person said nothing. */
export const EMPTY_CONVERSATION = "empty_conversation";

/**
 * True when the person said something: a turn of theirs with words in it. A chat
 * without that (the call dropped, or nobody spoke) is never saved, so it earns no
 * bonus and the sign-up can try again.
 */
export function hasUserWords(turns: ReadonlyArray<{ role: string; text: string }>): boolean {
  return turns.some((turn) => turn.role === "user" && typeof turn.text === "string" && turn.text.trim().length > 0);
}

/**
 * True when a sign-up has had its voice chat: one saved as completed in which the person said
 * something. Every place that asks "did they have the chat?" reads this, not plain `completed`:
 * the token route (one chat per sign-up), the complete route, the email link's auto open, the
 * journey condition "Used the voice chat" and the person's page. An older saved chat in which
 * nobody spoke (a call that dropped before empty chats were refused) does not count, so that
 * sign-up can try again.
 */
export function voiceChatDone(
  chat: { completed?: boolean; transcript?: ReadonlyArray<{ role: string; text: string }> } | null | undefined,
): boolean {
  return chat?.completed === true && Array.isArray(chat.transcript) && hasUserWords(chat.transcript);
}

/** Why a voice chat could not start, stopped, or was not saved. */
export type VoiceChatProblem =
  | "mic_blocked"
  | "no_mic"
  | "unavailable"
  | "already_done"
  | "start_failed"
  | "dropped"
  | "nothing_heard"
  | "save_failed";

/** Each problem's message in the widget catalog (src/lib/i18n/messages/*.json). */
export const VOICE_CHAT_PROBLEM_KEYS: Record<VoiceChatProblem, string> = {
  mic_blocked: "widget.voice.problem.micBlocked",
  no_mic: "widget.voice.problem.noMic",
  unavailable: "widget.voice.problem.unavailable",
  already_done: "widget.voice.problem.alreadyDone",
  start_failed: "widget.voice.problem.startFailed",
  dropped: "widget.voice.problem.dropped",
  nothing_heard: "widget.voice.problem.nothingHeard",
  save_failed: "widget.voice.problem.saveFailed",
};

/** The token route's answer as a problem: 503 when voice is off, 409 when this sign-up already chatted. */
export function tokenProblem(status: number, error: unknown): VoiceChatProblem {
  if (status === 503) return "unavailable";
  if (error === "already_completed") return "already_done";
  return "start_failed";
}

/** The browser's refusal of the microphone as a problem. */
export function microphoneProblem(err: unknown): VoiceChatProblem {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") return "mic_blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_mic";
  return "start_failed";
}

/**
 * A Live connection's close for the console: the code and Google's reason (which
 * names a refused model or token), never anything the person said.
 */
export function describeClose(event: { code?: unknown; reason?: unknown } | null | undefined): string {
  const code = typeof event?.code === "number" ? event.code : "none";
  const reason = typeof event?.reason === "string" ? event.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return reason ? `code ${code}: ${reason}` : `code ${code}`;
}
