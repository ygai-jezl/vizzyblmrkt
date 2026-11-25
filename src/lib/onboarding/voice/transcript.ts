import { ONBOARDING_LIMITS, type VoiceNote, type VoiceTurn } from "@/lib/types/onboarding";

/**
 * The browser's side of a Talk with Vizzy transcript: Live's transcription pieces as lines, and
 * the lines as uploads the server takes in order (POST .../conversations/[id]/turns and .../end).
 * Pure and client safe, so useVoiceCall.ts stays thin and this is tested on its own.
 */

/** Sent as text when the call opens: the model waits for the person otherwise. Never in the transcript. */
export const START_MESSAGE = "[Start] They are ready. Say hello and ask your first question.";
/** Sent with a minute left, so Vizzy wraps up in time. */
export const TIME_MESSAGE = "[Time] About one minute left. Wrap up now.";
/** Seconds left when TIME_MESSAGE goes. */
export const WRAP_UP_AT = 60;
/** How often finished lines go up during a call. */
export const FLUSH_MS = 5_000;
/** The longest wait for Vizzy's goodbye to finish playing before the call ends. */
export const GOODBYE_MS = 10_000;

const L = ONBOARDING_LIMITS;

export interface LiveLine {
  who: "member" | "vizzy";
  text: string;
  /** Seconds from the open connection when the line started. */
  atSec: number;
}

export interface Transcript {
  /** Finished lines: they never change. */
  lines: LiveLine[];
  /** The line still being heard, or null. */
  partial: LiveLine | null;
}

export const EMPTY_TRANSCRIPT: Transcript = { lines: [], partial: null };

/** A turn's words as the server keeps them (src/lib/onboarding/store.ts): one line, no control characters. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}

/** The line being heard, finished: it joins the lines unless it has no words. */
export function finishLine(t: Transcript): Transcript {
  if (!t.partial) return t;
  return { lines: cleanText(t.partial.text) ? [...t.lines, t.partial] : t.lines, partial: null };
}

/**
 * A piece of transcription. The same speaker carries on the line being heard; the other speaker
 * finishes it and starts a new one.
 */
export function addPiece(t: Transcript, who: LiveLine["who"], text: string, atSec: number): Transcript {
  if (!text) return t;
  if (t.partial && t.partial.who === who) return { lines: t.lines, partial: { ...t.partial, text: t.partial.text + text } };
  const finished = finishLine(t);
  return { lines: finished.lines, partial: { who, text: text.replace(/^\s+/, ""), atSec: clampSec(atSec) } };
}

const clampSec = (s: number) => Math.min(L.MAX_AT_SEC, Math.max(0, Math.floor(Number.isFinite(s) ? s : 0)));

/** Text cut into pieces of at most `max` characters, at a space where it can. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The finished lines as the server takes them: their words cleaned, a long line split into turns
 * of at most 2,000 characters, none empty. The same lines always give the same turns, so an
 * offset into them stays good while lines are added.
 */
export function turnsForUpload(lines: readonly LiveLine[]): VoiceTurn[] {
  return lines.flatMap((line) => pieces(cleanText(line.text), L.MAX_TURN_TEXT).map((text) => ({ who: line.who, text, atSec: clampSec(line.atSec) })));
}

export interface Upload {
  from: number;
  turns: VoiceTurn[];
  notes: VoiceNote[];
}

const encoder = new TextEncoder();
/** Room for the rest of an end's body ("reason"). */
const BODY_ROOM = 200;

/**
 * The next upload: the turns from `from` (at most 20) and the newest unsent notes (at most 8),
 * with turns dropped from its end until the body fits under the server's limit, which is also
 * under a closing page's 64 kB.
 */
export function nextUpload(turns: readonly VoiceTurn[], from: number, notes: readonly VoiceNote[]): Upload {
  const upload: Upload = {
    from,
    turns: turns.slice(from, from + L.TURNS_PER_APPEND),
    notes: notes.slice(-8),
  };
  while (upload.turns.length && encoder.encode(JSON.stringify(upload)).length > L.MAX_BODY_BYTES - BODY_ROOM) upload.turns.pop();
  return upload;
}

/** "4:05" from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Whether this page came by a soft navigation from another page (its document is still that
 * page's): the browser's navigation entry names another path. The microphone header belongs to
 * the document, so the welcome then loads itself once more. Unknown (no entry) is no.
 */
export function cameBySoftNavigation(navigationUrl: string | undefined, path: string): boolean {
  if (!navigationUrl) return false;
  try {
    const at = new URL(navigationUrl).pathname.replace(/\/+$/, "") || "/";
    return at !== path;
  } catch {
    return false;
  }
}
