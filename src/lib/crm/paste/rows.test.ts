import { describe, expect, it } from "vitest";
import { newPersonKey } from "@/lib/audience/addPerson";
import type { RecordField } from "@/lib/types/recordField";
import { mapColumns } from "./columns";
import { parseSheet } from "./parse";
import { firmDomain, isProfileSite, isSharedHost, readRows, type RowsRead } from "./rows";
import { DONE_WHEN_TSV, KIT_HEADER, KIT_TSV } from "./testing/samples";
import { ROW_REASONS, rowReasonLine } from "./words";

const AT = "2026-11-01T00:00:00.000Z";
const field = (key: string, label: string, type: RecordField["type"], object: RecordField["object"], over: Partial<RecordField> = {}) =>
  ({ key, label, type, object, createdAt: AT, createdBy: "usr_1", ...over }) as RecordField;
const STAGE = field("fld_00000000stag", "Stage", "multi_select", "company", { options: [{ id: "opt_00000000", label: "Seed" }, { id: "opt_00000001", label: "Series A" }] });
const HQ = field("fld_000000000fhq", "Fund HQ", "text", "company");
const LEADS = field("fld_00000000lead", "Num Lead Investments", "number", "company");
const TITLE = field("fld_0000000ptitl", "Title", "text", "person");
// A company field labelled like a person column: a firm row must never fill it.
const C_CITY = field("fld_00000000ccty", "Investor City", "text", "company");

function read(text: string, fields: { person?: RecordField[]; company?: RecordField[] } = {}): RowsRead {
  const parsed = parseSheet(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return readRows(parsed.sheet, mapColumns(parsed.sheet.header, { person: fields.person ?? [], company: fields.company ?? [] }));
}

describe("readRows", () => {
  it("makes a person of a row with an email, keyed as New person keys them", () => {
    const r = read("First Name\tLast Name\tEmail\nJo\tExample\t Jo@Example.com ");
    expect(r.rows).toEqual([{ row: 2, kind: "person", email: "jo@example.com", phone: null, firstName: "Jo", lastName: "Example", key: "jo@example.com", values: {} }]);
    expect(r.rows[0]!.kind === "person" && r.rows[0]!.key).toBe(newPersonKey({ email: " Jo@Example.com ", phone: null }));
    expect(r.left).toEqual([]);
  });

  it("keeps a stockist's name from a Business Name column on a firm row", () => {
    const r = read("Business Name\tWebsite\tOwner\nGreenleaf Garden Centre\tgreenleaf-garden.test\tJo Example");
    expect(r.rows).toEqual([{ row: 2, kind: "company", domain: "greenleaf-garden.test", name: "Greenleaf Garden Centre", values: {} }]);
    expect(JSON.stringify(r)).not.toContain("Jo Example");
  });

  it("makes a person of a row with only a phone, keyed by the trimmed phone", () => {
    const r = read("Name,Mobile\nPat Test,+44 7700 900123");
    expect(r.rows).toEqual([{ row: 2, kind: "person", email: null, phone: "+44 7700 900123", firstName: "Pat", lastName: "Test", key: "+44 7700 900123", values: {} }]);
  });

  it("splits a full name at its first space only when there are no first and last names", () => {
    expect(read("Full Name,Email\nMary Ann Example,mary@example.com").rows[0]).toMatchObject({ firstName: "Mary", lastName: "Ann Example" });
    expect(read("Name,First Name,Email\nJo Example,Joanna,jo@example.com").rows[0]).toMatchObject({ firstName: "Joanna", lastName: null });
  });

  it("makes a company of a row with only a firm's web address, by its domain", () => {
    const r = read("Company Name\tWebsite\nMeadow Seed Fund\thttps://www.meadow-seed.test/about?x=1\nOak Lane Lenders\toak-lane-lenders.test");
    expect(r.rows).toEqual([
      { row: 2, kind: "company", domain: "meadow-seed.test", name: "Meadow Seed Fund", values: {} },
      { row: 3, kind: "company", domain: "oak-lane-lenders.test", name: "Oak Lane Lenders", values: {} },
    ]);
  });

  it("leaves out a row with only a name, with the exact words", () => {
    const r = read("First Name,Last Name,Email,Website\nUna,Nameonly,,");
    expect(r.rows).toEqual([]);
    expect(r.left).toEqual([{ row: 2, reason: "no_contact" }]);
    expect(rowReasonLine(2, r.left[0]!.reason)).toBe("Row 2: Needs an email, a phone or a web address");
    expect(ROW_REASONS.no_contact).toBe("Needs an email, a phone or a web address");
  });

  it("leaves out a bad email as bad_email, never as a company, and a bad phone as bad_phone", () => {
    const r = read("Email,Phone,Website\njo at example,,https://meadow-seed.test\n,call me,\nkim@example.com,n/a,");
    expect(r.rows).toEqual([]);
    expect(r.left).toEqual([
      { row: 2, reason: "bad_email" },
      { row: 3, reason: "bad_phone" },
      { row: 4, reason: "bad_phone" },
    ]);
  });

  it("leaves out a profile page, a directory and a public email provider as not a firm's site", () => {
    const r = read(
      [
        "Company,Website",
        "Linked Only,https://www.linkedin.com/company/linked-only",
        "Signal,https://signal.nfx.com/investors/someone",
        "Mail,gmail.com",
        "Notion,https://someone.notion.site/fund",
        "Visible,connect.visible.vc/investors/x",
        "Spaces,not a site",
        "Mailto,mailto:jo@example.com",
      ].join("\n"),
    );
    expect(r.rows).toEqual([]);
    expect(r.left.map((l) => l.reason)).toEqual(Array(7).fill("not_a_firm_site"));
    expect(isProfileSite("www.x.com")).toBe(true);
    expect(isProfileSite("nfx.com")).toBe(false);
    expect(firmDomain("https://www.Northfield-Ventures.test:443/team")).toBe("northfield-ventures.test");
  });

  it("leaves out a firm whose web address is on a host many firms share, so they never become one company", () => {
    const shared = [
      "https://sites.google.com/view/northfield-ventures",
      "docs.google.com/document/d/abc",
      "https://bit.ly/3abcde",
      "northfield.wixsite.com/home",
      "https://harbour-lane.webflow.io",
      "quayside.substack.com",
      "https://fernhill-plants.github.io/",
      "oak-lane.carrd.co",
      "https://calendly.com/jo-example",
    ];
    const r = read(["Company,Website", ...shared.map((w, i) => `Firm ${i},${w}`)].join("\n"));
    expect(r.rows).toEqual([]);
    expect(r.left.map((l) => l.reason)).toEqual(Array(shared.length).fill("not_a_firm_site"));
    for (const w of shared) expect(firmDomain(w), w).toBeNull();
    expect(isSharedHost("northfield.wixsite.com")).toBe(true);
    expect(isSharedHost("www.northfield-ventures.test")).toBe(false);
    expect(isSharedHost("fernhill-plants.co.uk")).toBe(false);
    expect(firmDomain("https://www.fernhill-plants.co.uk/lenders")).toBe("fernhill-plants.co.uk");
    // Only a firm's web address: a link field may still hold a document (convertValue's badLink is isProfileSite).
    expect(isProfileSite("docs.google.com")).toBe(false);
  });

  it("makes one company of two partners at one firm, and leaves out the same email twice", () => {
    const r = read("Website,Email\nnorthfield-ventures.test,\nhttps://www.northfield-ventures.test/team,\n,jo@example.com\n,JO@example.com");
    expect(r.rows.map((x) => [x.row, x.kind])).toEqual([
      [2, "company"],
      [4, "person"],
    ]);
    expect(r.left).toEqual([
      { row: 3, reason: "repeated" },
      { row: 5, reason: "repeated" },
    ]);
  });

  it("keeps none of a firm row's names, titles, cities or profile links, whatever the field list says", () => {
    const r = read(KIT_TSV, { person: [TITLE], company: [STAGE, HQ, LEADS, C_CITY] });
    const firms = r.rows.filter((x) => x.kind === "company");
    expect(firms.map((f) => f.kind === "company" && f.domain)).toEqual(["northfield-ventures.test", "harbour-lane.test", "quayside-fund.test"]);
    const out = JSON.stringify(firms);
    for (const gone of ["Ada", "Example", "Ben", "Sample", "Cara", "Partner", "Principal", "Managing", "Associate", "Leeds", "York", "Bristol", "Cardiff", "Yorkshire", "Wales", "United Kingdom", "linkedin", "ada-example"]) {
      // Fund HQ is a company field, so a firm's own city stays when it is its HQ: check people's words only.
      if (gone === "Leeds" || gone === "Bristol" || gone === "Cardiff") continue;
      expect(out, gone).not.toContain(gone);
    }
    // The firm's own details stay: its name, its domain and its company fields.
    expect(firms[0]).toEqual({
      row: 2,
      kind: "company",
      domain: "northfield-ventures.test",
      name: "Northfield Ventures",
      values: { [STAGE.key]: ["opt_00000000", "opt_00000001"], [HQ.key]: "Leeds", [LEADS.key]: 12 },
    });
    expect(firms[1]).toMatchObject({ values: { [HQ.key]: "Bristol", [LEADS.key]: 3 } });
    // "1,204" is a number with a thousands comma; "Series A; Series B" keeps only Series A.
    expect(firms[2]).toMatchObject({ values: { [STAGE.key]: ["opt_00000001"], [HQ.key]: "Cardiff", [LEADS.key]: 1204 } });
    expect(r.left).toEqual([
      { row: 3, reason: "repeated" },
      { row: 6, reason: "not_a_firm_site" },
      { row: 7, reason: "no_contact" },
    ]);
    expect(r.notes.sort()).toEqual(["firms_left_out", "profile_links", "values_left_out"]);
    // The investor city column is never a company field's, though one is called that.
    expect(Object.keys(firms[0]!.values)).not.toContain(C_CITY.key);
    expect(KIT_HEADER).toContain("Investor City");
  });

  it("reads the done when list: 10 people, 3 companies and a name only left out", () => {
    const r = read(DONE_WHEN_TSV);
    expect(r.rows.filter((x) => x.kind === "person")).toHaveLength(10);
    expect(r.rows.filter((x) => x.kind === "company").map((x) => x.kind === "company" && x.domain)).toEqual(["meadow-seed.test", "oak-lane-lenders.test", "cobble-street.test"]);
    expect(r.left).toEqual([{ row: 15, reason: "no_contact" }]);
    // Person rows keep no web address or company name: nothing about the firm comes with them.
    expect(JSON.stringify(r.rows.filter((x) => x.kind === "person"))).not.toContain("Northfield Ventures");
  });

  it("keeps a person's own field values, and notes values that don't fit", () => {
    const r = read("Email\tTitle\tStage\njo@example.com\tPartner\tSeed\nkim@example.com\t" + "x".repeat(501) + "\t", { person: [TITLE], company: [STAGE] });
    expect(r.rows[0]).toMatchObject({ values: { [TITLE.key]: "Partner" } });
    // A company field is never filled on a person row.
    expect(Object.keys(r.rows[0]!.values)).toEqual([TITLE.key]);
    expect(r.rows[1]).toMatchObject({ values: {} });
    expect(r.notes).toContain("values_left_out");
  });

  it("leaves out names over 100 characters but keeps the person", () => {
    const r = read(`First Name,Email\n${"A".repeat(101)},jo@example.com`);
    expect(r.rows[0]).toMatchObject({ kind: "person", firstName: null, email: "jo@example.com" });
    expect(r.notes).toContain("values_left_out");
  });
});

describe("a list pasted onto an investor board", () => {
  // The board's Stage on People, and a company field for the firm's investment stages, as the kit's rows have them.
  const board = (label = "Stage") =>
    field("fld_0000000bstag", label, "status", "person", {
      options: [
        { id: "opt_research01", label: "Research" },
        { id: "opt_contact001", label: "Contacted" },
      ],
    });
  const KIT_CELLS = ["Ada", "Example", "Northfield Ventures", "northfield-ventures.test", "", "", "Partner", "Leeds", "", "United Kingdom", "Seed, Series A", "", "", "", "", ""];
  const FIRM_CELLS = ["", "", "Harbour Lane Capital", "harbour-lane.test", "", "", "", "", "", "", "Seed", "", "", "", "", ""];
  const paste = (header: string[], rows: string[][], person: RecordField) =>
    read([header, ...rows].map((r) => r.join("\t")).join("\n"), { person: [person], company: [STAGE] });

  it("puts each person in the stage their own Stage column names, with that column before or after the kit's", () => {
    const last = paste([...KIT_HEADER, "Email", "Stage"], [[...KIT_CELLS, "ada@example.com", "Research"], [...FIRM_CELLS, "", ""]], board());
    const first = paste(["Email", "Stage", ...KIT_HEADER], [["ada@example.com", "Research", ...KIT_CELLS], ["", "", ...FIRM_CELLS]], board());
    for (const r of [last, first]) {
      const ada = r.rows.find((x) => x.kind === "person");
      const firm = r.rows.find((x) => x.kind === "company");
      expect(ada && ada.kind === "person" && ada.values["fld_0000000bstag"]).toBe("opt_research01");
      // The firm keeps the kit's investment stage, whichever column came first.
      expect(firm && firm.kind === "company" && firm.values[STAGE.key]).toEqual(["opt_00000000"]);
      expect(r.notes).not.toContain("values_left_out");
    }
  });

  it("works when the board's field is called Stages, as the kit's column is", () => {
    const r = paste([...KIT_HEADER, "Email", "Stages"], [[...KIT_CELLS, "ada@example.com", "Contacted"]], board("Stages"));
    const ada = r.rows.find((x) => x.kind === "person");
    expect(ada && ada.kind === "person" && ada.values["fld_0000000bstag"]).toBe("opt_contact001");
  });

  it("fills both of a brand's Stages and Stage fields, whichever comes first in its field list", () => {
    const OWN = field("fld_000000ownstg", "Stages", "multi_select", "person", { options: [{ id: "opt_seed00001", label: "Seed" }, { id: "opt_seriesa01", label: "Series A" }] });
    for (const person of [[OWN, board()], [board(), OWN]]) {
      const r = read([[...KIT_HEADER, "Email", "Stage"], [...KIT_CELLS, "ada@example.com", "Research"]].map((x) => x.join("\t")).join("\n"), { person, company: [] });
      const ada = r.rows.find((x) => x.kind === "person");
      expect(ada && ada.kind === "person" && ada.values).toEqual({ fld_0000000bstag: "opt_research01", fld_000000ownstg: ["opt_seed00001", "opt_seriesa01"] });
    }
  });

  it("keeps the kit's Stages in a firm's text field even with a Stage column first", () => {
    const FIRM_STAGES = field("fld_00000cstages", "Stages", "text", "company");
    const r = read(
      [["Stage", ...KIT_HEADER, "Email"], ["Research", ...FIRM_CELLS, ""]].map((x) => x.join("\t")).join("\n"),
      { person: [board()], company: [FIRM_STAGES] },
    );
    const firm = r.rows.find((x) => x.kind === "company");
    expect(firm && firm.kind === "company" && firm.values).toEqual({ fld_00000cstages: "Seed" });
  });

  it("keeps the first cell that fits, trying the columns of the field's exact name first", () => {
    const two = (a: string, b: string) => {
      const r = read(`Email\tStage\tStage\nada@example.com\t${a}\t${b}`, { person: [board()] });
      const ada = r.rows[0]!;
      return ada.kind === "person" ? ada.values["fld_0000000bstag"] : undefined;
    };
    expect(two("Research", "Contacted")).toBe("opt_research01");
    expect(two("Contacted", "Research")).toBe("opt_contact001");
    expect(two("", "Contacted")).toBe("opt_contact001");
    // A text field named Stage: your own Stage column wins over the kit's Stages before it.
    const TEXT = field("fld_00000tstage", "Stage", "text", "person");
    const r = read("Email\tStages\tStage\nada@example.com\tSeed\tResearch", { person: [TEXT] });
    const ada = r.rows[0]!;
    expect(ada.kind === "person" && ada.values[TEXT.key]).toBe("Research");
  });

  it("keeps the kit's Stages on a firm with a People field Stages and a company field Stage", () => {
    const OWN = field("fld_000000ownstg", "Stages", "multi_select", "person", { options: [{ id: "opt_seed00001", label: "Seed" }] });
    const r = read([KIT_HEADER, FIRM_CELLS].map((x) => x.join("\t")).join("\n"), { person: [OWN], company: [STAGE] });
    const firm = r.rows.find((x) => x.kind === "company");
    expect(firm && firm.kind === "company" && firm.values[STAGE.key]).toEqual(["opt_00000000"]);
  });

  it("passes over a cell too long to read when another column fits, with no note", () => {
    const r = read(`Email\tStage\tStage\nada@example.com\t${"x".repeat(2_001)}\tResearch`, { person: [board()] });
    const ada = r.rows[0]!;
    expect(ada.kind === "person" && ada.values["fld_0000000bstag"]).toBe("opt_research01");
    expect(r.notes).not.toContain("values_left_out");
  });

  it("keeps a value kept in part from the first column, with the note", () => {
    const MULTI = field("fld_00000msector", "Sectors", "multi_select", "person", { options: [{ id: "opt_climate01", label: "Climate" }, { id: "opt_food00001", label: "Food" }] });
    const r = read("Email\tSectors\tSectors\nada@example.com\tClimate, Space\tClimate, Food", { person: [MULTI] });
    const ada = r.rows[0]!;
    expect(ada.kind === "person" && ada.values[MULTI.key]).toEqual(["opt_climate01"]);
    expect(r.notes).toContain("values_left_out");
  });

  it("notes a value left out only when no column of that field fits", () => {
    const none = paste([...KIT_HEADER, "Email", "Stage"], [[...KIT_CELLS, "ada@example.com", "Someday"]], board());
    const ada = none.rows.find((x) => x.kind === "person");
    expect(ada && ada.kind === "person" && "fld_0000000bstag" in ada.values).toBe(false);
    expect(none.notes).toContain("values_left_out");
  });
});
