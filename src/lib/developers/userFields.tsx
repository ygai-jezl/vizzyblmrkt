import type { ReactNode } from "react";
import { C } from "@/components/developers/Doc";
import type { UserPatch, UserView } from "@/lib/connect/v2/contract";

/**
 * What each field of a user's state means — ONE source for the "Sending users"
 * page's field table and the OpenAPI spec's descriptions, so the two can't
 * disagree. Notes are plain text where `backticks` mark code: the spec uses
 * them as Markdown, the page renders them with the Doc building blocks.
 */

export interface FieldDoc<K extends string = string> {
  name: K;
  type: string;
  notes: string;
}

/** The body of PATCH /api/v2/users/{userId} — every key of UserPatchSchema, in reading order. */
export const USER_FIELDS: ReadonlyArray<FieldDoc<keyof UserPatch & string>> = [
  { name: "email", type: "string | null", notes: "Their email address, ≤ 254 chars. We can't email anyone without one. An invalid value is left as it was and listed in `ignoredFields`, not a 400." },
  { name: "firstName", type: "string | null", notes: "Used in greetings (falls back to “there”), ≤ 100 chars. An invalid value is left as it was and listed in `ignoredFields`, not a 400." },
  { name: "lastName", type: "string | null", notes: "≤ 100 chars. An invalid value is left as it was and listed in `ignoredFields`, not a 400." },
  {
    name: "timezone",
    type: "string | null",
    notes: "An IANA time zone, e.g. `Europe/London`. Emails go out in each person's morning; without one, in your connection's default time zone. An invalid value is left as it was and listed in `ignoredFields`, not a 400.",
  },
  { name: "locale", type: "string | null", notes: "A BCP 47 locale, e.g. `en-GB`. An invalid value is left as it was and listed in `ignoredFields`, not a 400." },
  {
    name: "signedUpAt",
    type: "string",
    notes:
      "When the account was created: ISO 8601 with a timezone. It starts sign-up journeys while the person is inside the journey's window (72 hours by default), so sending past users with their real date is safe. It can be changed, not cleared.",
  },
  {
    name: "consent",
    type: "string | null",
    notes:
      "Your legal basis for marketing email: `consent`, `soft_opt_in`, `corporate_subscriber` or `none`. Service emails (like a welcome) don't need one; a marketing email that's due without one is skipped. `corporate_subscriber` counts as `none` for free-mail addresses (gmail.com, …).",
  },
  {
    name: "subscribed",
    type: "boolean",
    notes: "`false`: they opted out of this email in your product, so they get no more lifecycle email. `true` lifts only that opt-out — never an unsubscribe made in our emails.",
  },
  {
    name: "excluded",
    type: "object | null",
    notes:
      "`{\"reason\": \"staff\"}` (reason ≤ 64 chars): never email this person, in any journey — staff, test accounts, invited teammates. `null` lets them into journeys that start from then on.",
  },
  {
    name: "steps",
    type: "object",
    notes:
      "Onboarding step id → when it was done (ISO 8601), or `null` for not done. Use your catalog's ids: lower-case letters, digits, `_` and `-`. Merged key by key; at most 50.",
  },
  {
    name: "facts",
    type: "object",
    notes: "Fact id → its latest value: a number, a string (≤ 200 chars) or a boolean. `null` removes one. Merged key by key; at most 50.",
  },
  {
    name: "traits",
    type: "object",
    notes:
      "Anything else journeys can branch on, e.g. `plan`: a string (≤ 500 chars), number or boolean. `null` removes one. Keys start with a letter, then letters, digits, `_` or `-`. Email, names, timezone and locale are fields of their own, so they're refused here. Merged key by key; at most 50.",
  },
  {
    name: "updatedAt",
    type: "string",
    notes: "Optional: when you read this state (ISO 8601). A write older than the newest one applied is ignored (`stale_write`).",
  },
];

/** A user's id — in the URL, or on each batch item. */
export const USER_ID_NOTES =
  "Your own id for the user, ≤ 256 chars — the same one everywhere. In a URL, encode it (`encodeURIComponent`). `batch`, `.` and `..` can't be used.";

/** What GET and a PATCH response return — every key of UserViewSchema. */
export const STATE_NOTES: Record<keyof UserView & string, string> = {
  userId: "Your id for the user.",
  email: "As you last sent it; `null` if you haven't.",
  firstName: "As you last sent it; `null` if you haven't.",
  lastName: "As you last sent it; `null` if you haven't.",
  timezone: "As you last sent it; `null` if you haven't.",
  locale: "As you last sent it; `null` if you haven't.",
  signedUpAt: "When the account was created, in UTC; `null` if you haven't sent it.",
  consent: "The legal basis you sent.",
  subscribed: "`false` while they're opted out in your product. Unsubscribes made in our emails are in `optOuts` (GET only).",
  excluded: "Set while they're excluded from every journey.",
  steps: "Step id → when it was done, in UTC.",
  facts: "Fact id → the latest value you sent.",
  traits: "Trait key → value.",
  updatedAt: "The newest `updatedAt` applied, or `null` if you've never sent one.",
  enrolments:
    "The journeys they're in or have been through: the journey's id, `status` (`active`, `completed` or `exited`), `mode` (`test`, `shadow` or `live`) and when they joined.",
  optOuts:
    "Unsubscribes made in YouGrow's emails: `scope` `all` or `category` (with the `category`), and when. The API can't lift them, and `subscribed: true` doesn't either.",
};

/** Notes → page content: `backticked` parts become code. */
export function codeText(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/g)
    .filter(Boolean)
    .map((part, i) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <C key={i}>{part.slice(1, -1)}</C> : part));
}
