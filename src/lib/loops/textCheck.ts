/**
 * The one check on words a person gives the loops (learning loops step 4): a note with a vote
 * (3.11 of the plan for steps 4 and 5) and, from the one writer, a look's words (3.4). Words with a
 * link, an email address, an @handle or a phone number are refused, never cleaned and kept, so
 * nothing that reaches a person or a prompt later carries contact details. Pure and client safe,
 * so a box can say so before it sends.
 */

/** What the words held, so the refusal can be counted. */
export const TEXT_REFUSALS = ["link", "email", "handle", "phone"] as const;
export type TextRefusal = (typeof TEXT_REFUSALS)[number];

/** What a vote's note box says when its words are refused; the box stays open. */
export const NOTE_REFUSED_MESSAGE = "Leave out links, email addresses, handles and phone numbers.";

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const SCHEME_OR_WWW = /\b(?:https?:\/\/|www\.)\S/i;
/**
 * A bare address such as hearthbakery.com/menu. Only endings that are rarely a word, so a missing
 * space after a full stop ("dark wood.It needs light") is never taken for a link.
 */
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|dev|shop|store|info|biz|xyz|online|site|co\.uk|org\.uk)\b/i;
const HANDLE = /(?<![\w.@])@[A-Za-z0-9_]{2,}/;
/** A run of digits with spaces, dots, brackets, plus signs or hyphens between them. */
const DIGIT_RUN = /\+?\d[\d\s().+-]{7,}\d/g;
/** A phone number holds at least 9 digits, so a year range such as 2020 to 2024 written 2020-2024 is kept. */
const PHONE_DIGITS = 9;

/** Why these words can't be kept, or null when they can. */
export function textRefusalOf(text: string): TextRefusal | null {
  if (EMAIL.test(text)) return "email";
  if (SCHEME_OR_WWW.test(text) || BARE_DOMAIN.test(text)) return "link";
  if (HANDLE.test(text)) return "handle";
  for (const run of text.match(DIGIT_RUN) ?? []) {
    if ((run.match(/\d/g) ?? []).length >= PHONE_DIGITS) return "phone";
  }
  return null;
}
