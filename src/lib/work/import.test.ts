import { describe, expect, it } from "vitest";
import { delimiterOf, eachRecord, importFileName, matchColumns, parseRecords, parseSheet, readCheck, readSheet, readStatus } from "./import";

// Made-up Backlog tabs, as a CSV file or as Google Sheets copies them (tabs).
const LUMEN_CSV = [
  "MVP,Ref,Backlog item,Description,Notes,Status,Clippings",
  'Yes,12,Register the company,"Limited company, two directors",,Done,',
  ',64,Interview 5 team admins,"30 minutes each, the same ""6 questions""",3 of 5 done,WIP,',
  ',73,SOC 2 for the Team plan,"Type 1 before we sell to companies',
  'over 50 people",Auditor call on 15 Jan,WIP,SOC 2 checklist for small teams',
  ",80,Import from other note apps,,,Someday,https://notes.example/import-guide",
  ",,,,,,",
  ",,Check new sign ups get a team space,,,Not started,",
].join("\r\n");

const FERNHILL_PASTE = [
  "MVP\tRef\tBacklog item\tDescription\tNotes\tStatus\tStage\tCheck",
  "Yes\t9\tVan insurance\tCover for deliveries too\tTwo quotes so far\tNot started\t3 Set up\t2026-12-09",
  "\t16\tDelivery zones for the online shop\t\tAfter the van insurance\tBlocked\tMarket\twhen #9 is done",
  "\t18\tWorkshops in store\tSaturday mornings, 8 people a time\t\tIdea\t\t",
  "\t20\tAsk 20 customers about Saturday workshops\t\t14 of 20 asked\tDoing\tcustomers\t",
].join("\n");

describe("reading a sheet", () => {
  it("splits CSV with quoted commas, doubled quotes, line breaks in quotes, CRLF and a byte order mark", () => {
    const rows = parseRecords(`\uFEFF${LUMEN_CSV}`, ",");
    expect(rows[0]).toEqual(["MVP", "Ref", "Backlog item", "Description", "Notes", "Status", "Clippings"]);
    expect(rows[1]![3]).toBe("Limited company, two directors");
    expect(rows[2]![3]).toBe('30 minutes each, the same "6 questions"');
    expect(rows[3]![3]).toBe("Type 1 before we sell to companies\r\nover 50 people");
    expect(rows[3]).toHaveLength(7);
  });

  it("tells a paste from Google Sheets (tabs) from a CSV file", () => {
    expect(delimiterOf(FERNHILL_PASTE)).toBe("\t");
    expect(delimiterOf(LUMEN_CSV)).toBe(",");
    expect(parseSheet(FERNHILL_PASTE).rows[0]!.cells[3]).toBe("Cover for deliveries too");
  });

  it("numbers each row as its record in the sheet, the header being 1, and leaves blank rows out", () => {
    const sheet = parseSheet(LUMEN_CSV);
    expect(sheet.rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 7]);
    expect(sheet.more).toBe(false);
    expect(parseSheet("\n\nTask\n\nFirst\n").rows).toEqual([{ row: 5, cells: ["First"] }]);
  });

  it("stops one row past the cap, so a body of line breaks or rows past it is refused without being read in full", () => {
    // About 1.5 million line breaks: blank lines, so nothing is kept for them.
    let handed = 0;
    eachRecord(`Title\n${"\n".repeat(1_500_000)}`, ",", () => ((handed += 1), true));
    expect(handed).toBe(1);
    expect(parseSheet(`Title\n${"\n".repeat(1_500_000)}`, 1000)).toMatchObject({ headers: ["Title"], rows: [], more: false });
    // 1.5 million rows: the read stops at the 1,001st.
    const sheet = parseSheet(`Title\n${"a\n".repeat(1_500_000)}`, 1000);
    expect(sheet.more).toBe(true);
    expect(sheet.rows).toHaveLength(1000);
    expect(sheet.rows[999]!.row).toBe(1001);
    expect(parseSheet("Title\na\nb\nc\nd", 3)).toMatchObject({ rows: [{ cells: ["a"] }, { cells: ["b"] }, { cells: ["c"] }], more: true });
    expect(parseSheet("Title\na\nb\nc", 3).more).toBe(false);
  });

  it("keeps at most 100 cells of a record", () => {
    expect(parseRecords(`${"x,".repeat(500)}y`, ",")[0]).toHaveLength(100);
  });
});

describe("matching columns", () => {
  it("matches the Backlog tab's headers by name, ignoring case and punctuation, and skips the rest", () => {
    expect(matchColumns(["MVP", "Ref", "Backlog item", "Description", "Notes", "Status", "Clippings", "Owner", "stage ", "CHECK"]).map((c) => c.field)).toEqual([
      "mustHave",
      "ref",
      "title",
      "description",
      "notes",
      "status",
      "clipping",
      "skip",
      "stage",
      "check",
    ]);
  });

  it("takes the person's pick over the match, and fills each field from its first column only", () => {
    const cols = matchColumns(["Task", "Item", "Who"], { Item: "title", Task: "notes" });
    expect(cols.map((c) => c.field)).toEqual(["notes", "title", "skip"]);
    expect(matchColumns(["Title", "Task"]).map((c) => c.field)).toEqual(["title", "skip"]);
    expect(matchColumns(["Status"], { Status: "skip" })[0]!.field).toBe("skip");
  });
});

describe("reading rows", () => {
  it("reads each row's fields, keeping refs, Must have, a clipping link and an unknown status as To do", () => {
    const sheet = parseSheet(LUMEN_CSV);
    const r = readSheet(sheet, matchColumns(sheet.headers));
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => [x.row, x.ref, x.title, x.status, x.mustHave])).toEqual([
      [2, 12, "Register the company", "done", true],
      [3, 64, "Interview 5 team admins", "in_progress", false],
      [4, 73, "SOC 2 for the Team plan", "in_progress", false],
      [5, 80, "Import from other note apps", "todo", false],
      [7, null, "Check new sign ups get a team space", "todo", false],
    ]);
    expect(r.rows[2]!.notes).toBe("Auditor call on 15 Jan\nClipping: SOC 2 checklist for small teams");
    expect(r.rows[3]!.links).toEqual([{ url: "https://notes.example/import-guide" }]);
    expect(r.rows[3]!.unknownStatus).toBe("Someday");
    expect(r.unknownStatuses).toEqual(["Someday"]);
  });

  it("reads stages and checks from a paste", () => {
    const sheet = parseSheet(FERNHILL_PASTE);
    const r = readSheet(sheet, matchColumns(sheet.headers));
    expect(r.rows.map((x) => [x.ref, x.stage, x.check, x.status])).toEqual([
      [9, "set_up", { kind: "date", day: "2026-12-09" }, "todo"],
      [16, "market", { kind: "after_task", ref: 9 }, "waiting"],
      [18, null, null, "todo"],
      [20, "customers", null, "in_progress"],
    ]);
    expect(r.unknownStatuses).toEqual(["Idea"]);
  });

  it("refuses a row with no task, a bad or repeated ref, a check it can't read, or a field too long, by row", () => {
    const text = [
      "Ref,Backlog item,Check,Description",
      "1,First,,",
      "1,Again,,",
      "x2,Bad ref,,",
      "3,,,",
      "4,Bad check,next week sometime,",
      `5,Long,,${"a".repeat(4001)}`,
      "6,Fine,after 1,",
    ].join("\n");
    const sheet = parseSheet(text);
    const r = readSheet(sheet, matchColumns(sheet.headers));
    expect(r.problems).toEqual([
      { row: 3, problem: "ref_twice" },
      { row: 4, problem: "ref_bad" },
      { row: 5, problem: "no_title" },
      { row: 6, problem: "check_bad" },
      { row: 7, problem: "too_long" },
    ]);
    expect(r.rows.map((x) => x.title)).toEqual(["First", "Fine"]);
  });

  it("reads status words and checks the way sheets write them", () => {
    expect(readStatus("WIP")).toEqual({ status: "in_progress", known: true });
    expect(readStatus("  not   started ")).toEqual({ status: "todo", known: true });
    expect(readStatus("Blocked")).toEqual({ status: "waiting", known: true });
    expect(readStatus("Cancelled")).toEqual({ status: "dropped", known: true });
    expect(readStatus("Parked")).toEqual({ status: "todo", known: false });
    expect(readCheck("#75")).toEqual({ kind: "after_task", ref: 75 });
    expect(readCheck("when 75 is done")).toEqual({ kind: "after_task", ref: 75 });
    expect(readCheck("2026-02-30")).toBe("bad");
    expect(readCheck("")).toBeNull();
  });

  it("keeps a file's base name only", () => {
    expect(importFileName("C:\\Users\\x\\Backlog.csv")).toBe("Backlog.csv");
    expect(importFileName("/tmp/a/Backlog\n.csv")).toBe("Backlog .csv");
    expect(importFileName("")).toBeNull();
    expect(importFileName(undefined)).toBeNull();
  });
});
