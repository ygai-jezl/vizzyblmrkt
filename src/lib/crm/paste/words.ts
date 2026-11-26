/**
 * Paste a list (RAISE_PASTE_ENABLED): every word the sheet, the routes, Review, the timeline and
 * Vizzy's tool say, in one place, so the help page can quote them. Pure and client safe.
 *
 * House style (src/lib/content/writingRules.ts): no em or en dashes, no spaced hyphens, none of
 * the AI tells. Any business, not only one raising money.
 */

export const PASTE_WORDS = {
  button: "Paste a list",
  title: "Paste a list",
  lead: "Paste rows from a sheet or a CSV file, with the header row first. A row with an email or a phone becomes a person. A row with only a firm's web address becomes a company.",
  anyList: "Investors, lenders, grant bodies, stockists: any list works.",
  rowsLabel: "Rows",
  rowsPlaceholder: "Paste here, header row first",
  rowsHint: "Up to 50 rows at a time.",
  sourceLabel: "Where is this list from?",
  sourcePlaceholder: "For example: a directory, a friend's sheet, an event",
  sourceHint: "Kept on each person and company it adds, so you can tell them where you found their details.",
  read: "Read the list",
  reading: "Reading…",
  columnsRead: "Read as",
  columnsLeft: "Left out",
  tableRow: "Row",
  tableAdds: "Adds",
  tableName: "Name",
  tableContact: "Email, phone or web address",
  kindPerson: "Person",
  kindCompany: "Company",
  adding: "Adding…",
  dismiss: "Dismiss",
  waits: "It waits in Review for 7 days, then goes.",
  done: "Done",
  pasteAgain: "Paste another list",
} as const;

/** The notes under a read list, by code. */
export const PASTE_NOTES = {
  firms_left_out: "Left out from firms: names, titles, cities and profile links. Add an email you have to add a person.",
  profile_links: "Profile links are never kept.",
  values_left_out: "Some values didn't fit your fields, so they were left out.",
  not_yet: "Everyone starts at Not yet for marketing emails. Record that someone agreed on their page.",
} as const;
export type PasteNote = Exclude<keyof typeof PASTE_NOTES, "not_yet">;
export const PASTE_NOTE_CODES = ["firms_left_out", "profile_links", "values_left_out"] as const satisfies readonly PasteNote[];

/** What a route's error code says. The help page (paste-a-list, #messages) quotes them. */
export const PASTE_MESSAGES = {
  source_needed: "Say where this list is from.",
  empty: "Paste some rows first, with the header row.",
  no_header: "The first row should name the columns, such as Email, First Name or Website.",
  too_many_rows: "That's more than 50 rows. Paste up to 50 at a time.",
  too_many_columns: "That's more than 40 columns. Copy only the columns you need.",
  too_long: "That's too much text to read at once. Paste fewer rows or columns.",
  too_large: "Those rows hold too much for one card. Paste fewer rows, or leave out long columns.",
  nothing_to_add: "Nothing to add: every row is already here or was left out.",
  forbidden: "Only admins can paste a list.",
  rate_limited: "That's a lot of lists at once. Wait a minute, then try again.",
  paste_gone: "This list is no longer waiting: someone added it, dismissed it, or it was more than 7 days old.",
  changed: "Someone else is adding this list. Reload to see where it stands.",
  consent_not_allowed: "Nobody can be added as agreeing to emails from a pasted list. Record that on their page.",
  invalid_input: "Check the list and try again.",
  failed: "That didn't work. Try again.",
} as const;
export type PasteMessage = keyof typeof PASTE_MESSAGES;

/** Why a row isn't added, shown as "Row 7: …". */
export const ROW_REASONS = {
  no_contact: "Needs an email, a phone or a web address",
  bad_email: "The email address doesn't look right",
  bad_phone: "The phone number doesn't look right",
  not_a_firm_site: "Use the firm's own web address, not a profile page",
  repeated: "Same as an earlier row",
  in_people: "Already in People",
  in_companies: "Already in Companies",
} as const;
export type RowReason = keyof typeof ROW_REASONS;

/** A skipped row in words. */
export function rowReasonLine(row: number, reason: RowReason): string {
  return `Row ${row}: ${ROW_REASONS[reason]}`;
}

/** The words for an error code a paste route answered, falling back to "That didn't work". */
export function pasteErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: unknown };
  return typeof d.error === "string" && Object.hasOwn(PASTE_MESSAGES, d.error) ? PASTE_MESSAGES[d.error as PasteMessage] : PASTE_MESSAGES.failed;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "10 people and 3 companies", "1 person", "1 company"; "nobody" for none. */
export function batchCountWords(c: { people: number; companies: number }): string {
  const parts = [c.people ? plural(c.people, "person", "people") : null, c.companies ? plural(c.companies, "company", "companies") : null].filter(Boolean);
  return parts.length ? parts.join(" and ") : "nobody";
}

/** "Read 13 rows: 10 people and 3 companies to add, 1 left out." Each part only when not zero. */
export function readSummary(read: number, people: number, companies: number, left: number): string {
  const parts = [people || companies ? `${batchCountWords({ people, companies })} to add` : null, left ? `${left} left out` : null].filter(Boolean);
  const rows = plural(read, "row", "rows");
  return parts.length ? `Read ${rows}: ${parts.join(", ")}.` : `Read ${rows}.`;
}

/** The sheet's add button: "Add 10 people and 3 companies". */
export function addWords(c: { people: number; companies: number }): string {
  return `Add ${batchCountWords(c)}`;
}

/** After the add: "Added 10 people and 3 companies. Each timeline says where the list is from." */
export function addedWords(c: { people: number; companies: number }): string {
  return `Added ${batchCountWords(c)}. Each timeline says where the list is from.`;
}

/** Rows already here when the list was added. */
export function alreadyAtAdd(n: number): string {
  return n === 1 ? "1 was already here, so it was left as it is." : `${n} were already here, so they were left as they are.`;
}

/** Opened from Review, where the skipped rows aren't kept: how many there were. */
export function fromReview(n: number): string {
  return n === 1 ? "1 row was left out when the list was read." : `${n} rows were left out when the list was read.`;
}

/** What Vizzy's tool says once a list is read into a card. */
export function agentSummary(read: number, people: number, companies: number, left: number): string {
  return `${readSummary(read, people, companies, left)} Nobody is added until an admin opens the card and adds them. It waits in Review for 7 days.`;
}

/** Vizzy's card. */
export const PASTE_CARD = {
  title: "Pasted list, ready to add",
  note: "Nobody is added until an admin adds them. Everyone starts at Not yet for emails.",
  cta: "Open the list",
} as const;

/** The Review section and its items. */
export const PASTE_REVIEW = {
  title: "Pasted lists",
  description: "Lists your team pasted on People, waiting for an admin to add them. Nobody is added until then.",
  itemTitle: "A pasted list, ready to add",
  action: "Open",
} as const;

/** A waiting list's Review detail: "10 people and 3 companies. Where it's from: <source>. It goes after 7 days." */
export function reviewDetail(c: { people: number; companies: number }, source: string): string {
  const words = batchCountWords(c);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}. Where it's from: ${source}. It goes after 7 days.`;
}

/** The timeline's words for someone added from a pasted list (the date shows beside it). */
export const PASTE_TIMELINE = {
  text: "Added from a pasted list",
} as const;

/** "By Jo Example. Where it's from: <source>", or without a name "Where it's from: <source>". */
export function timelineDetail(by: string | null, source: string | null): string | null {
  const from = source ? `Where it's from: ${source}` : null;
  if (by && from) return `By ${by}. ${from}`;
  return by ? `By ${by}` : from;
}

/** A person's page: "Added from a pasted list by Jo Example on 26 Nov. Where it's from: <source>." */
export function personPastedLine(by: string | null, day: string, source: string | null): string {
  return `Added from a pasted list${by ? ` by ${by}` : ""} on ${day}.${source ? ` Where it's from: ${source}.` : ""}`;
}

/** A company's detail: "Added from a pasted list on 26 Nov. Where it's from: <source>." */
export function companyPastedLine(day: string, source: string | null): string {
  return `Added from a pasted list on ${day}.${source ? ` Where it's from: ${source}.` : ""}`;
}

/** Remove company, for a company with no people (an admin, while paste is on). */
export const COMPANY_REMOVE = {
  button: "Remove company",
  confirm: "Remove this company? It has no people, so only the company and its own fields go.",
  has_people: "This company has people, so it can't be removed here. It goes when its last person is erased.",
  failed: "That didn't work. Try again.",
} as const;

/** Every fixed string above, for the house style test. */
export const ALL_PASTE_STRINGS: readonly string[] = [
  ...Object.values(PASTE_WORDS),
  ...Object.values(PASTE_NOTES),
  ...Object.values(PASTE_MESSAGES),
  ...Object.values(ROW_REASONS),
  ...Object.values(PASTE_CARD),
  ...Object.values(PASTE_REVIEW),
  ...Object.values(PASTE_TIMELINE),
  ...Object.values(COMPANY_REMOVE),
];
