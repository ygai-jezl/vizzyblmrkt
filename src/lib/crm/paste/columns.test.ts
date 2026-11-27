import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { convertValue, headerKey, isPersonOnlyHeader, isProfileHeader, mapColumns, plainNumber } from "./columns";
import { KIT_HEADER } from "./testing/samples";

const AT = "2026-11-01T00:00:00.000Z";
function field(key: string, label: string, type: RecordField["type"], object: RecordField["object"], over: Partial<RecordField> = {}): RecordField {
  return { key, label, type, object, createdAt: AT, createdBy: "usr_1", ...over } as RecordField;
}
const opts = (...labels: string[]) => labels.map((label, i) => ({ id: `opt_0000000${i}`, label }));

// The brand's own fields: a few on People, a few on companies, some with labels that a firm row must never fill.
const STAGE = field("fld_00000000stag", "Stage", "multi_select", "company", { options: opts("Pre-seed", "Seed", "Series A", "Series B") });
const SECTOR = field("fld_00000000sect", "Sector", "multi_select", "company", { options: opts("Climate", "Food", "Health", "Retail") });
const HQ = field("fld_000000000fhq", "Fund HQ", "text", "company");
const LEADS = field("fld_00000000lead", "Num Lead Investments", "number", "company");
const TOTAL = field("fld_00000000totl", "Total Number of Investments", "number", "company");
const RECENT = field("fld_00000000rcnt", "Recent Investments", "text", "company");
const P_TITLE = field("fld_0000000ptitl", "Title", "text", "person");
const P_CITY = field("fld_00000000pcty", "Investor City", "text", "person");
// Company fields with person labels: never filled from a firm row.
const C_TITLE = field("fld_0000000ctitl", "Title", "text", "company");
const C_CITY = field("fld_00000000ccty", "Investor City", "text", "company");
const C_FIRST = field("fld_0000000cfrst", "First Name", "text", "company");
const OWNER = field("fld_00000000ownr", "Owner", "team_member", "person");
const C_EMAIL = field("fld_0000000cemal", "Contact", "email", "company");

const PEOPLE = [P_TITLE, P_CITY, OWNER];
const COMPANIES = [STAGE, SECTOR, HQ, LEADS, TOTAL, RECENT, C_TITLE, C_CITY, C_FIRST, C_EMAIL];

describe("headerKey", () => {
  it("compares lower case, letters and digits only, accents off, a trailing s dropped", () => {
    expect(headerKey("E-mail")).toBe("email");
    expect(headerKey("Stages")).toBe(headerKey("Stage"));
    expect(headerKey("  Investor's Country ")).toBe("investorscountry");
    expect(headerKey("Prénom")).toBe("prenom");
  });
});

describe("mapColumns", () => {
  it("reads every kit column as the spec says", () => {
    const map = mapColumns([...KIT_HEADER], { person: PEOPLE, company: COMPANIES });
    const by = Object.fromEntries(KIT_HEADER.map((h, i) => [h, map.columns[i]]));
    expect(by["First Name"]).toEqual({ kind: "standard", column: "first_name" });
    expect(by["Last Name"]).toEqual({ kind: "standard", column: "last_name" });
    expect(by["Company Name"]).toEqual({ kind: "standard", column: "company_name" });
    expect(by["Website"]).toEqual({ kind: "standard", column: "website" });
    expect(by["Person Linkedin Url"]).toEqual({ kind: "profile" });
    expect(by["Company Linkedin Url"]).toEqual({ kind: "profile" });
    // Title and Investor City only through a People field; never a company field, whatever its label.
    expect(by["Title"]).toEqual({ kind: "field", person: P_TITLE, company: null });
    expect(by["Investor City"]).toEqual({ kind: "field", person: P_CITY, company: null });
    expect(by["Investor State"]).toEqual({ kind: "left" });
    expect(by["Investor's Country"]).toEqual({ kind: "left" });
    // "Stages" fills a "Stage" field: the trailing s is dropped.
    expect(by["Stages"]).toEqual({ kind: "field", person: null, company: STAGE });
    expect(by["Sectors"]).toEqual({ kind: "field", person: null, company: SECTOR });
    expect(by["Fund HQ"]).toEqual({ kind: "field", person: null, company: HQ });
    expect(by["Num Lead Investments"]).toEqual({ kind: "field", person: null, company: LEADS });
    expect(by["Total Number of Investments"]).toEqual({ kind: "field", person: null, company: TOTAL });
    expect(by["Recent Investments"]).toEqual({ kind: "field", person: null, company: RECENT });
    expect(map.profileLinks).toBe(true);
    expect(map.isHeader).toBe(true);
    expect(map.read).toContainEqual({ header: "Stages", as: "Stage" });
    expect(map.read).toContainEqual({ header: "Website", as: "Web address" });
    expect(map.left).toEqual(["Person Linkedin Url", "Company Linkedin Url", "Investor State", "Investor's Country"]);
  });

  it("never keeps a profile column on any row, whatever a field is called", () => {
    const linkedIn = field("fld_000000linked", "LinkedIn", "link", "person");
    const map = mapColumns(["Email", "LinkedIn", "Twitter handle", "Profile URL", "Socials", "AngelList", "Crunchbase page"], { person: [linkedIn], company: [] });
    expect(map.columns.slice(1).every((c) => c.kind === "profile")).toBe(true);
    for (const h of ["Facebook", "instagram_link", "Profile", "Social"]) expect(isProfileHeader(h), h).toBe(true);
    expect(isProfileHeader("Website")).toBe(false);
  });

  it("matches the brand's own fields by label, ignoring case, spaces, punctuation and a trailing s", () => {
    const map = mapColumns(["email", "STAGE", "sector(s)", "fund-hq"], { person: [], company: COMPANIES });
    expect(map.columns.slice(1)).toEqual([
      { kind: "field", person: null, company: STAGE },
      { kind: "field", person: null, company: SECTOR },
      { kind: "field", person: null, company: HQ },
    ]);
  });

  it("never reads a firm row's person columns into a company field, investor or not", () => {
    for (const h of ["First Name", "Title", "Job Title", "Role", "Position", "City", "State", "Country", "Location", "Investor City", "Investor's Country", "Investor Title"]) {
      expect(isPersonOnlyHeader(h), h).toBe(true);
    }
    const map = mapColumns(["Website", "Title", "Investor City", "First Name"], { person: [], company: COMPANIES });
    // First Name stays the standard column (read only on person rows); the others have no company field.
    expect(map.columns.slice(1)).toEqual([{ kind: "left" }, { kind: "left" }, { kind: "standard", column: "first_name" }]);
  });

  it("never fills a team member field, a company email field, or an archived field", () => {
    const archived = field("fld_00000000arch", "Notes", "text", "person", { archivedAt: AT });
    const map = mapColumns(["Email", "Owner", "Contact", "Notes"], { person: [OWNER, archived], company: [C_EMAIL] });
    expect(map.columns.slice(1)).toEqual([{ kind: "left" }, { kind: "left" }, { kind: "left" }]);
  });

  it("fills each field from its first column only", () => {
    const map = mapColumns(["Website", "Stage", "Stages"], { person: [], company: [STAGE] });
    expect(map.columns.slice(1)).toEqual([{ kind: "field", person: null, company: STAGE }, { kind: "left" }]);
  });

  it("reads a shop's or a lender's own words for the firm's name", () => {
    const map = mapColumns(["Business Name", "Shop Name", "Store Name", "Organisation Name", "Organization Name", "Business", "Shop", "Store"], { person: [], company: [] });
    expect(map.columns.every((c) => c.kind === "standard" && c.column === "company_name")).toBe(true);
  });

  it("reads Business, Shop or Store as the brand's own field of that name when it has one", () => {
    const store = field("fld_00000000stor", "Store", "text", "person");
    const map = mapColumns(["Email", "Store", "Business Name"], { person: [store], company: [] });
    expect(map.columns).toEqual([
      { kind: "standard", column: "email" },
      { kind: "field", person: store, company: null },
      { kind: "standard", column: "company_name" },
    ]);
    expect(map.read).toEqual([
      { header: "Email", as: "Email" },
      { header: "Store", as: "Store" },
      { header: "Business Name", as: "Company name" },
    ]);
  });

  it("says the first row isn't a header when it holds values or names nothing it knows", () => {
    expect(mapColumns(["Jo", "jo@example.com"], { person: [], company: [] }).isHeader).toBe(false);
    expect(mapColumns(["Meadow Seed Fund", "https://meadow-seed.test"], { person: [], company: [] }).isHeader).toBe(false);
    expect(mapColumns(["Meadow Seed Fund", "meadow-seed.test"], { person: [], company: [] }).isHeader).toBe(false);
    expect(mapColumns(["Website"], { person: [], company: [] }).isHeader).toBe(true);
  });

  it("shows header names at most 60 characters long, never a cell", () => {
    const long = `Website ${"x".repeat(80)}`;
    expect(mapColumns(["Email", long], { person: [], company: [] }).left).toEqual([long.slice(0, 60)]);
  });
});

describe("convertValue", () => {
  it("keeps text up to 500 characters", () => {
    expect(convertValue(HQ, "  Leeds ")).toEqual({ ok: true, value: "Leeds", partial: false });
    expect(convertValue(HQ, "x".repeat(500)).ok).toBe(true);
    expect(convertValue(HQ, "x".repeat(501))).toEqual({ ok: false });
    expect(convertValue(HQ, "")).toEqual({ ok: true, value: null, partial: false });
  });

  it("reads numbers with spaces and thousands commas, never 250k", () => {
    expect(plainNumber("1,204")).toBe("1204");
    expect(plainNumber("12 000")).toBe("12000");
    expect(plainNumber("1,5")).toBeNull();
    expect(convertValue(LEADS, "1,204")).toMatchObject({ ok: true, value: 1204 });
    expect(convertValue(LEADS, "-3.5")).toMatchObject({ ok: true, value: -3.5 });
    expect(convertValue(LEADS, "250k")).toEqual({ ok: false });
  });

  it("reads an amount in the field's currency as whole minor units", () => {
    const gbp = field("fld_000000cheque", "Cheque", "currency", "company", { currency: "GBP" });
    const jpy = field("fld_0000000yenam", "Yen", "currency", "company", { currency: "JPY" });
    expect(convertValue(gbp, "£250,000")).toMatchObject({ ok: true, value: 25_000_000 });
    expect(convertValue(gbp, "GBP 12.50")).toMatchObject({ ok: true, value: 1250 });
    expect(convertValue(jpy, "¥1,000")).toMatchObject({ ok: true, value: 1000 });
    expect(convertValue(gbp, "250k")).toEqual({ ok: false });
    expect(convertValue(gbp, "about 5")).toEqual({ ok: false });
  });

  it("reads a date only as YYYY-MM-DD", () => {
    const met = field("fld_000000000met", "Met", "date", "person");
    expect(convertValue(met, "2026-11-26")).toMatchObject({ ok: true, value: "2026-11-26" });
    expect(convertValue(met, "26/11/2026")).toEqual({ ok: false });
    expect(convertValue(met, "2026-02-30")).toEqual({ ok: false });
  });

  it("reads a checkbox from yes, no, true, false, y, n, 1, 0 and x", () => {
    const box = field("fld_000000000box", "Warm", "checkbox", "person");
    for (const v of ["yes", "TRUE", "y", "1", "x"]) expect(convertValue(box, v), v).toMatchObject({ ok: true, value: true });
    for (const v of ["no", "False", "n", "0"]) expect(convertValue(box, v), v).toMatchObject({ ok: true, value: false });
    expect(convertValue(box, "maybe")).toEqual({ ok: false });
  });

  it("reads a select or status by an option's label or id, ignoring case, spaces and hyphens", () => {
    const sel = field("fld_00000000selc", "Fit", "select", "person", { options: opts("Good fit", "Pre-seed only") });
    expect(convertValue(sel, "GOOD FIT")).toMatchObject({ ok: true, value: "opt_00000000" });
    expect(convertValue(sel, "preseed only")).toMatchObject({ ok: true, value: "opt_00000001" });
    expect(convertValue(sel, "opt_00000001")).toMatchObject({ ok: true, value: "opt_00000001" });
    expect(convertValue(sel, "Maybe")).toEqual({ ok: false });
    const archived = field("fld_00000000selx", "Fit", "status", "person", { options: [{ id: "opt_00000000", label: "Old", archivedAt: AT }] });
    expect(convertValue(archived, "Old")).toEqual({ ok: false });
  });

  it("keeps only the options a multi select matches, and says when some were left out", () => {
    expect(convertValue(STAGE, "Seed, Series A")).toEqual({ ok: true, value: ["opt_00000001", "opt_00000002"], partial: false });
    expect(convertValue(STAGE, "Series A; Series B | seed")).toMatchObject({ ok: true, value: ["opt_00000002", "opt_00000003", "opt_00000001"], partial: false });
    expect(convertValue(STAGE, "Seed, Growth")).toEqual({ ok: true, value: ["opt_00000001"], partial: true });
    expect(convertValue(STAGE, "Growth")).toEqual({ ok: false });
  });

  it("keeps a link only with http or https, and never one the caller refuses", () => {
    const site = field("fld_0000000psite", "Blog", "link", "person");
    expect(convertValue(site, "https://fernhill-plants.test/blog")).toMatchObject({ ok: true, value: "https://fernhill-plants.test/blog" });
    expect(convertValue(site, "fernhill-plants.test")).toEqual({ ok: false });
    expect(convertValue(site, "ftp://fernhill-plants.test")).toEqual({ ok: false });
    expect(convertValue(site, "https://www.linkedin.com/in/someone", { badLink: (u) => u.hostname.endsWith("linkedin.com") })).toEqual({ ok: false });
  });

  it("fills email and phone fields on People only, and never a team member", () => {
    const work = field("fld_00000000work", "Work email", "email", "person");
    const tel = field("fld_00000000ptel", "Office", "phone", "person");
    expect(convertValue(work, "Jo@Example.com")).toMatchObject({ ok: true, value: "jo@example.com" });
    expect(convertValue(work, "not an address")).toEqual({ ok: false });
    expect(convertValue(tel, "+44 7700 900123")).toMatchObject({ ok: true, value: "+44 7700 900123" });
    expect(convertValue(C_EMAIL, "jo@example.com")).toEqual({ ok: false });
    expect(convertValue(OWNER, "usr_1")).toEqual({ ok: false });
  });
});
