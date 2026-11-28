import {
  amountToMinor,
  checkFieldValue,
  FIELD_LIMITS,
  isCalendarDay,
  liveOptions,
  type FieldValue,
  type RecordField,
} from "@/lib/types/recordField";
import { PASTE_LIMITS } from "./parse";

/**
 * Paste a list (RAISE_PASTE_ENABLED): which column is read as what, and how a cell becomes a field
 * value. Pure, and the same for every brand: the rule RULE_DECISIONS.paste_columns names, which
 * never learns, since the list shows how every column was read before an admin adds a row.
 *
 * - Headers are compared lower case with everything but letters and digits taken off, and a
 *   trailing s dropped ("E-mail" is "email", "Stages" is "stage").
 * - The standard columns (email, phone, names, the firm's name and web address) are read by their
 *   usual headers. Any other header equal to a live field's label fills that field: a People field
 *   on person rows, a company field on firm rows. Business, Shop and Store name the firm only when
 *   the brand has no field of that name (FIELD_FIRST_HEADERS).
 * - On each list, People and companies, a column fills the field of its exact name ("Stage" fills
 *   Stage, "Stages" fills Stages), or else one a trailing s away, and the columns of one name go to
 *   its fields in turn. A field named by several columns takes, on each row, the first cell that
 *   fits it, trying the columns of its exact name first (rows.ts), so the kit's "Stages" and a
 *   "Stage" column of the board's own stages both work, in either order.
 * - Profile links (LinkedIn, X and the like) are never kept, on any row.
 * - Firm rows never fill a field from a column about a person (names, title, role, city, state,
 *   country, location, or any of those with "investor" before it), whatever the field list says,
 *   so nothing about the people at a firm is kept from a row with no way to reach them.
 * - Team member fields are never filled, and email and phone fields only on person rows.
 */

/** The columns every list may have. */
export const STANDARD_COLUMNS = ["email", "phone", "first_name", "last_name", "full_name", "company_name", "website"] as const;
export type StandardColumn = (typeof STANDARD_COLUMNS)[number];

/** How a standard column shows under "Read as". */
export const STANDARD_WORDS: Record<StandardColumn, string> = {
  email: "Email",
  phone: "Phone",
  first_name: "First name",
  last_name: "Last name",
  full_name: "Name",
  company_name: "Company name",
  website: "Web address",
};

/** The headers each standard column is read from. */
export const STANDARD_HEADERS: Record<StandardColumn, readonly string[]> = {
  email: ["Email", "Email Address", "E-mail", "Mail", "Work Email", "Personal Email", "Contact Email"],
  phone: ["Phone", "Phone Number", "Mobile", "Mobile Phone", "Cell", "Telephone", "Tel"],
  first_name: ["First Name", "First", "Given Name", "Forename"],
  last_name: ["Last Name", "Last", "Surname", "Family Name"],
  full_name: ["Name", "Full Name", "Contact Name", "Person Name"],
  company_name: [
    "Company Name",
    "Company",
    "Firm",
    "Firm Name",
    "Fund",
    "Fund Name",
    "Organisation",
    "Organization",
    "Organisation Name",
    "Organization Name",
    "Business",
    "Business Name",
    "Shop",
    "Shop Name",
    "Store",
    "Store Name",
  ],
  website: ["Website", "Website Url", "Web", "Web Address", "Url", "Site", "Homepage", "Domain", "Company Website", "Firm Website", "Fund Website"],
};

/**
 * Firm name headers that a brand may also use for a field of its own (a plant shop's People field
 * "Store", for the shop someone buys from): read as that field when the brand has one of that
 * name, and as the firm's name otherwise.
 */
export const FIELD_FIRST_HEADERS = ["Business", "Shop", "Store"] as const;

/** A header containing one of these holds profile links: never kept. */
export const PROFILE_PARTS = ["linkedin", "twitter", "facebook", "instagram", "crunchbase", "angellist"] as const;
/** Headers that are profile links whole. */
export const PROFILE_HEADERS = ["Profile", "Profile Url", "Profile Link", "Social", "Socials"] as const;
/** Headers about a person, which firm rows never read into any field (also with "investor" before them). */
export const PERSON_ONLY_HEADERS = [
  "First Name",
  "First",
  "Given Name",
  "Forename",
  "Last Name",
  "Last",
  "Surname",
  "Family Name",
  "Name",
  "Full Name",
  "Contact Name",
  "Person Name",
  "Title",
  "Job Title",
  "Role",
  "Position",
  "City",
  "State",
  "Country",
  "Location",
] as const;

/** A header as written: letters and digits only, lower case, accents off ("Stages" stays "stages"). */
export function plainKey(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** A header as compared: letters and digits only, lower case, accents off, a trailing s dropped. */
export function headerKey(header: string): string {
  return plainKey(header).replace(/s$/, "");
}

const STANDARD_BY_KEY = new Map<string, StandardColumn>(STANDARD_COLUMNS.flatMap((c) => STANDARD_HEADERS[c].map((h) => [headerKey(h), c] as const)));
const PROFILE_KEYS = new Set<string>(PROFILE_HEADERS.map(headerKey));
const PERSON_ONLY_KEYS = new Set<string>(PERSON_ONLY_HEADERS.map(headerKey));
const FIELD_FIRST_KEYS = new Set<string>(FIELD_FIRST_HEADERS.map(headerKey));

/** Whether a column holds profile links, which are never kept. */
export function isProfileHeader(header: string): boolean {
  const plain = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PROFILE_PARTS.some((p) => plain.includes(p)) || PROFILE_KEYS.has(headerKey(header));
}

/** Whether a column is about a person, so firm rows never read it into a field. */
export function isPersonOnlyHeader(header: string): boolean {
  const key = headerKey(header);
  // "Cities" and "Countries" as well as "City" and "Country".
  return [key, key.replace(/ie$/, "y")].some((k) => PERSON_ONLY_KEYS.has(k) || PERSON_ONLY_KEYS.has(k.replace(/^investors?/, "")));
}

/** A header cell that is plainly a value (an address, a link, a phone number): the list has no header row. */
function looksLikeData(cell: string): boolean {
  return cell.includes("@") || /^https?:\/\//i.test(cell) || /^www\./i.test(cell) || /^\+?\d[\d ().-]{5,}$/.test(cell);
}

/** A field a pasted column can fill: in use, never a team member, and email or phone only on People. */
export function fillable(field: RecordField): boolean {
  if (field.archivedAt || field.erasingSince || field.type === "team_member") return false;
  return field.object === "person" || (field.type !== "email" && field.type !== "phone");
}

export type ColumnRead =
  | { kind: "standard"; column: StandardColumn }
  | { kind: "profile" }
  /** A field of that label: the People field on person rows, the company field on firm rows. */
  | { kind: "field"; person: RecordField | null; company: RecordField | null }
  | { kind: "left" };

export interface ColumnMap {
  /** One per header column, in order. */
  columns: ColumnRead[];
  /** How the header was read, header names only, never a cell: at most 40, each at most 60 characters. */
  read: Array<{ header: string; as: string }>;
  left: string[];
  /** A column of profile links was there (never kept). */
  profileLinks: boolean;
  /** The first row names columns: no cell in it looks like a value, and at least one is known. */
  isHeader: boolean;
}

const shown = (header: string) => header.slice(0, PASTE_LIMITS.headerChars);

/** Read a header against the brand's two field lists. */
export function mapColumns(header: readonly string[], fields: { person: readonly RecordField[]; company: readonly RecordField[] }): ColumnMap {
  const person = fields.person.filter((f) => f.object === "person" && fillable(f));
  const company = fields.company.filter((f) => f.object === "company" && fillable(f));
  // The field a column fills on one list: of its exact name, or else a trailing s away, each one
  // not yet taken by an earlier column first, so two fields of one name get a column each.
  const used = new Set<string>();
  const fieldOf = (list: readonly RecordField[], h: string): RecordField | null => {
    const exact = list.filter((f) => plainKey(f.label) === plainKey(h));
    const all = exact.length ? exact : list.filter((f) => headerKey(f.label) === headerKey(h));
    const f = all.find((x) => !used.has(x.key)) ?? all[0] ?? null;
    if (f) used.add(f.key);
    return f;
  };
  const columns: ColumnRead[] = [];
  const read: ColumnMap["read"] = [];
  const left: string[] = [];
  let profileLinks = false;
  let known = false;
  for (const h of header) {
    const key = headerKey(h);
    let col: ColumnRead = { kind: "left" };
    // The brand's fields of this header's name, on each list.
    const fieldsNamed = () => {
      const p = fieldOf(person, h);
      const c = isPersonOnlyHeader(h) ? null : fieldOf(company, h);
      return p || c ? { p, c } : null;
    };
    const named = key && !isProfileHeader(h) && (!STANDARD_BY_KEY.has(key) || FIELD_FIRST_KEYS.has(key)) ? fieldsNamed() : null;
    if (!key) {
      // A header with no letters or digits names nothing.
    } else if (isProfileHeader(h)) {
      col = { kind: "profile" };
      profileLinks = true;
    } else if (named) {
      col = { kind: "field", person: named.p, company: named.c };
    } else if (STANDARD_BY_KEY.has(key)) col = { kind: "standard", column: STANDARD_BY_KEY.get(key)! };
    columns.push(col);
    if (col.kind !== "left") known = true;
    if (col.kind === "standard") read.push({ header: shown(h), as: STANDARD_WORDS[col.column] });
    else if (col.kind === "field") read.push({ header: shown(h), as: shown((col.person ?? col.company)!.label) });
    else if (h) left.push(shown(h));
  }
  return { columns, read: read.slice(0, PASTE_LIMITS.columns), left: left.slice(0, PASTE_LIMITS.columns), profileLinks, isHeader: known && !header.some(looksLikeData) };
}

// --- Values --------------------------------------------------------------------------------------

export type Converted = { ok: true; value: FieldValue | null; partial: boolean } | { ok: false };

const NO = { ok: false } as const;
const ok = (value: FieldValue | null, partial = false): Converted => ({ ok: true, value, partial });
const optionKey = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");

/** Digits, spaces and thousands commas, with an optional point: "1,250.50" is "1250.50". Null for anything else ("250k"). */
export function plainNumber(raw: string): string | null {
  const v = raw.replace(/\s+/g, "");
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return v;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) return v.replace(/,/g, "");
  return null;
}

/** The option a cell names, by its label or id, ignoring case, spaces and hyphens. */
function optionOf(field: RecordField, raw: string): string | null {
  const k = optionKey(raw);
  return liveOptions(field).find((o) => o.id === raw || optionKey(o.label) === k)?.id ?? null;
}

/** The value as checked by the field's own rule (checkFieldValue). */
function checked(field: RecordField, value: unknown, partial = false): Converted {
  const c = checkFieldValue(field, value);
  return c.ok ? ok(c.value, partial) : NO;
}

/**
 * A cell as the field stores it, or not at all. `partial`: a multi select kept only some of what
 * it named. `badLink` refuses a link the caller won't keep (a profile page).
 */
export function convertValue(field: RecordField, raw: string, opts: { badLink?: (url: URL) => boolean } = {}): Converted {
  const v = raw.trim();
  if (!v) return ok(null);
  switch (field.type) {
    case "text":
      return v.length > PASTE_LIMITS.keptTextChars ? NO : checked(field, v);
    case "number": {
      const n = plainNumber(v);
      return n === null ? NO : checked(field, Number(n));
    }
    case "currency": {
      let s = v.replace(/\p{Sc}/gu, "").trim();
      const code = field.currency ?? "";
      if (code && s.toUpperCase().startsWith(code)) s = s.slice(code.length);
      if (code && s.toUpperCase().endsWith(code)) s = s.slice(0, -code.length);
      const n = plainNumber(s.trim());
      if (n === null) return NO;
      const minor = amountToMinor(n, field.currency);
      return Number.isSafeInteger(minor) ? checked(field, minor) : NO;
    }
    case "date":
      return isCalendarDay(v) ? checked(field, v) : NO;
    case "checkbox": {
      const b = v.toLowerCase();
      if (["yes", "true", "y", "1", "x"].includes(b)) return ok(true);
      if (["no", "false", "n", "0"].includes(b)) return ok(false);
      return NO;
    }
    case "select":
    case "status": {
      const id = optionOf(field, v);
      return id ? checked(field, id) : NO;
    }
    case "multi_select": {
      const parts = v
        .split(/[,;|]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const named = new Set(parts.map(optionKey)).size;
      const ids = [...new Set(parts.map((p) => optionOf(field, p)).filter((id): id is string => !!id))];
      const kept = ids.slice(0, FIELD_LIMITS.multiSelect);
      if (!kept.length) return NO;
      return checked(field, kept, kept.length < named);
    }
    case "link": {
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return NO;
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || opts.badLink?.(url)) return NO;
      return checked(field, v);
    }
    case "email":
      return field.object === "person" ? checked(field, v.replace(/^mailto:/i, "")) : NO;
    case "phone":
      return field.object === "person" ? checked(field, v) : NO;
    case "team_member":
      return NO;
  }
}
