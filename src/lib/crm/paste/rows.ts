import { canonicalDomain } from "@/lib/crm/identifiers";
import { getDomain } from "tldts";
import { isPublicEmailProvider, normalizeHost, registrableDomain } from "@/lib/domains/registrableDomain";
import { NAME_MAX, parseNewPerson } from "@/lib/audience/newPerson";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import type { FieldValue, RecordField } from "@/lib/types/recordField";
import { convertValue, isPersonOnlyHeader, type ColumnMap, type StandardColumn } from "./columns";
import type { Sheet } from "./parse";
import type { PasteNote, RowReason } from "./words";

/**
 * Paste a list (RAISE_PASTE_ENABLED): what each row becomes (decisions 8 and 9). Pure.
 *
 * 1. An email cell that holds no valid address is left out (`bad_email`), and so is a phone that
 *    fails New person's rule (`bad_phone`): a typo never turns a person into a firm.
 * 2. An email or a phone: a person, checked by New person's own rules (parseNewPerson). Names
 *    over 100 characters are left out of the row.
 * 3. Otherwise a web address: a company, by its registrable domain. A public email provider, a
 *    profile page, a directory or a host many firms share (a shortener, a site builder, a
 *    document) is left out (`not_a_firm_site`).
 * 4. Otherwise the row is left out (`no_contact`).
 * 5. The same person or the same firm again is left out (`repeated`): several partners at one
 *    firm make one company.
 *
 * A firm row keeps only the firm's name, its web address and the brand's company fields. Its
 * names, titles, cities and profile links are never read into what it becomes, and a left out row
 * becomes only its number and reason.
 */

/** Profile and directory sites, by registrable domain: a firm's own site is never one of these. */
export const NOT_A_FIRM_SITE = [
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "crunchbase.com",
  "angel.co",
  "wellfound.com",
  "notion.site",
  "notion.so",
  "linktr.ee",
  "medium.com",
  "youtube.com",
  "tiktok.com",
  "github.com",
  "openvc.app",
  "pitchbook.com",
  "tracxn.com",
  "dealroom.co",
] as const;
/** Directories on a host of a domain that is otherwise a firm's. */
export const NOT_A_FIRM_HOST = ["signal.nfx.com", "connect.visible.vc"] as const;

/**
 * Hosts many firms share, by registrable domain: link shorteners, site builders, blogs, forms and
 * documents. A firm's page on one is never its own domain, so keying a company on it would make
 * every firm there one company. Refused only as a firm's web address: a link field may still hold
 * one (a deck on a document host). Site builders on the public suffix list's private part
 * (x.wixsite.com, x.webflow.io, x.github.io and the like) are refused by that list too.
 */
export const SHARED_HOST = [
  "google.com",
  "bit.ly",
  "tinyurl.com",
  "lnkd.in",
  "t.co",
  "about.me",
  "calendly.com",
  "airtable.com",
  "typeform.com",
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "webflow.io",
  "substack.com",
  "wordpress.com",
  "carrd.co",
  "weebly.com",
  "godaddysites.com",
  "business.site",
  "dropbox.com",
  "canva.com",
] as const;

const NOT_A_FIRM = new Set<string>(NOT_A_FIRM_SITE);
const NOT_A_FIRM_HOSTS = new Set<string>(NOT_A_FIRM_HOST);
const SHARED = new Set<string>(SHARED_HOST);

/** Whether a host is on a host many firms share (SHARED_HOST, or a private public suffix such as wixsite.com). */
export function isSharedHost(host: string): boolean {
  const h = normalizeHost(host);
  const reg = registrableDomain(h);
  if (reg === null) return false;
  return SHARED.has(reg) || getDomain(h, { allowPrivateDomains: true }) !== reg;
}

/** Whether a host is a profile page or a directory, never a firm's own site. */
export function isProfileSite(host: string): boolean {
  const h = normalizeHost(host).replace(/^www\./, "");
  if (NOT_A_FIRM_HOSTS.has(h)) return true;
  const reg = registrableDomain(h);
  return reg !== null && NOT_A_FIRM.has(reg);
}

/** A firm's web address as its canonical domain, or null when it isn't a firm's own site. */
export function firmDomain(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  // An address or a login in it ("mailto:jo@…", "user@host") is never a firm's own site.
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  if (isProfileSite(url.hostname) || isSharedHost(url.hostname)) return null;
  const domain = canonicalDomain(url.hostname);
  if (!domain || isPublicEmailProvider(domain)) return null;
  return domain;
}

/** Why a row is left out when it is read. Already being in People or Companies is found when it is saved. */
export type LeftReason = Exclude<RowReason, "in_people" | "in_companies">;

export interface PersonRowRead {
  row: number;
  kind: "person";
  /** Normalised, as New person keeps it. */
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  /** The person key: the address, else the trimmed phone (newPersonKey). */
  key: string;
  /** People field values by field id. */
  values: Record<string, FieldValue>;
}

export interface CompanyRowRead {
  row: number;
  kind: "company";
  domain: string;
  name: string | null;
  /** Company field values by field id. */
  values: Record<string, FieldValue>;
}

export type RowRead = PersonRowRead | CompanyRowRead;

export interface RowsRead {
  rows: RowRead[];
  left: Array<{ row: number; reason: LeftReason }>;
  notes: PasteNote[];
}

/** The longest firm name kept, as a company's profile name. */
const COMPANY_NAME_MAX = 200;
/** Longer cells than New person takes are refused up front, as its form would refuse them. */
const EMAIL_MAX = 320;
const PHONE_MAX = 40;

/** Read every row of a sheet against how its columns were read. */
export function readRows(sheet: Sheet, map: ColumnMap): RowsRead {
  const notes = new Set<PasteNote>();
  if (map.profileLinks) notes.add("profile_links");
  const left: RowsRead["left"] = [];
  const rows: RowRead[] = [];
  const people = new Set<string>();
  const firms = new Set<string>();
  const of = (column: StandardColumn) => map.columns.flatMap((c, i) => (c.kind === "standard" && c.column === column ? [i] : []));
  const at = { email: of("email"), phone: of("phone"), first: of("first_name"), last: of("last_name"), full: of("full_name"), firm: of("company_name"), site: of("website") };

  for (const { row, cells } of sheet.rows) {
    // The first column of a kind with something in it; undefined when none has, null for a cell too long to read.
    const first = (cols: number[]): string | null | undefined => {
      for (const i of cols) if (cells[i] !== "") return cells[i] ?? null;
      return undefined;
    };
    const email = first(at.email);
    const phone = first(at.phone);
    if (email === null || (email !== undefined && (email.replace(/^mailto:/i, "").length > EMAIL_MAX))) {
      left.push({ row, reason: "bad_email" });
      continue;
    }
    if (phone === null || (phone !== undefined && phone.length > PHONE_MAX)) {
      left.push({ row, reason: "bad_phone" });
      continue;
    }

    if (email !== undefined || phone !== undefined) {
      const name = (v: string | null | undefined): string | undefined => {
        if (v === undefined) return undefined;
        if (v === null || v.length > NAME_MAX) {
          notes.add("values_left_out");
          return undefined;
        }
        return v;
      };
      let firstName = name(first(at.first));
      let lastName = name(first(at.last));
      if (firstName === undefined && lastName === undefined) {
        const full = name(first(at.full));
        if (full) {
          const space = full.indexOf(" ");
          firstName = space < 0 ? full : full.slice(0, space);
          lastName = space < 0 ? undefined : full.slice(space + 1).trim() || undefined;
        }
      }
      const parsed = parseNewPerson({
        ...(email ? { email: email.replace(/^mailto:/i, "") } : {}),
        ...(phone ? { phone } : {}),
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
      });
      if (!parsed.ok) {
        left.push({ row, reason: parsed.error === "invalid_phone" ? "bad_phone" : "bad_email" });
        continue;
      }
      const p = parsed.value;
      const normalized = p.email ? normalizeEmail(p.email) : null;
      const key = normalized || p.phone!.trim();
      if (people.has(key)) {
        left.push({ row, reason: "repeated" });
        continue;
      }
      people.add(key);
      rows.push({ row, kind: "person", email: normalized, phone: p.phone, firstName: p.firstName, lastName: p.lastName, key, values: valuesOf(cells, map, "person", notes) });
      continue;
    }

    const site = first(at.site);
    if (site === undefined || site === null) {
      left.push({ row, reason: site === null ? "not_a_firm_site" : "no_contact" });
      continue;
    }
    const domain = firmDomain(site);
    if (!domain) {
      left.push({ row, reason: "not_a_firm_site" });
      continue;
    }
    if (firms.has(domain)) {
      left.push({ row, reason: "repeated" });
      continue;
    }
    firms.add(domain);
    const firmName = first(at.firm);
    let name: string | null = null;
    if (firmName === null || (firmName && firmName.length > COMPANY_NAME_MAX)) notes.add("values_left_out");
    else if (firmName) name = firmName;
    // Anything about a person on a firm row is left out, and the note says so.
    if (map.columns.some((c, i) => cells[i] !== "" && aboutAPerson(c, sheet.header[i] ?? ""))) notes.add("firms_left_out");
    rows.push({ row, kind: "company", domain, name, values: valuesOf(cells, map, "company", notes) });
  }
  return { rows, left, notes: [...notes] };
}

/** A column a firm row never keeps: a person's name, a profile link, a person-only field, or a header about a person. */
function aboutAPerson(c: ColumnMap["columns"][number], header: string): boolean {
  if (c.kind === "standard") return c.column === "first_name" || c.column === "last_name" || c.column === "full_name";
  if (c.kind === "profile") return true;
  if (c.kind === "field") return c.company === null;
  return isPersonOnlyHeader(header);
}

/** One row's field values for one object, each converted and checked; what doesn't fit is noted and left out. */
function valuesOf(cells: ReadonlyArray<string | null>, map: ColumnMap, object: "person" | "company", notes: Set<PasteNote>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  map.columns.forEach((c, i) => {
    if (c.kind !== "field") return;
    const field: RecordField | null = object === "person" ? c.person : c.company;
    if (!field) return;
    const cell = cells[i];
    if (cell === null) {
      notes.add("values_left_out");
      return;
    }
    if (!cell) return;
    const v = convertValue(field, cell, { badLink: (u) => isProfileSite(u.hostname) });
    if (!v.ok) {
      notes.add("values_left_out");
      return;
    }
    if (v.partial) notes.add("values_left_out");
    if (v.value !== null) out[field.key] = v.value;
  });
  return out;
}
