import { describe, expect, it } from "vitest";
import { delimiterOf, PASTE_LIMITS, parseSheet, type Sheet } from "./parse";
import { csvOf, KIT_HEADER, KIT_TSV } from "./testing/samples";

function sheet(text: string): Sheet {
  const r = parseSheet(text);
  if (!r.ok) throw new Error(r.error);
  return r.sheet;
}

describe("parseSheet", () => {
  it("reads rows copied from a sheet with tabs, the header as row 1", () => {
    const s = sheet(KIT_TSV);
    expect(s.delimiter).toBe("\t");
    expect(s.header).toEqual([...KIT_HEADER]);
    expect(s.rows).toHaveLength(6);
    expect(s.rows[0]).toMatchObject({ row: 2, cells: expect.arrayContaining(["Ada", "Example", "Northfield Ventures"]) });
    expect(s.rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("reads a CSV with quoted commas, doubled quotes and a new line inside quotes", () => {
    const text = 'Email,Name,Notes\njo@example.com,"Example, Jo","Said ""yes"" at the fair\nand again by email"\n"kim@example.com" , Kim , plain';
    const s = sheet(text);
    expect(s.delimiter).toBe(",");
    expect(s.rows).toEqual([
      { row: 2, cells: ["jo@example.com", "Example, Jo", 'Said "yes" at the fair\nand again by email'] },
      { row: 3, cells: ["kim@example.com", "Kim", "plain"] },
    ]);
  });

  it("reads semicolons when the header has more of them than commas", () => {
    expect(delimiterOf("Email;Name;Notes, more")).toBe(";");
    const s = sheet("Email;Company\njo@example.com;Fernhill Plants, Ltd");
    expect(s.rows[0]!.cells).toEqual(["jo@example.com", "Fernhill Plants, Ltd"]);
  });

  it("reads quoted tabs and new lines in a sheet copied with tabs", () => {
    const s = sheet('Email\tNotes\njo@example.com\t"one\ttwo\nthree"\nkim@example.com\tfour');
    expect(s.rows).toEqual([
      { row: 2, cells: ["jo@example.com", "one\ttwo\nthree"] },
      { row: 3, cells: ["kim@example.com", "four"] },
    ]);
  });

  it("reads a Markdown table and skips its rule line", () => {
    const s = sheet("| Email | Website |\n|---|:---:|\n| jo@example.com | |\n| | https://meadow-seed.test |");
    expect(s.delimiter).toBe("|");
    expect(s.header).toEqual(["Email", "Website"]);
    expect(s.rows).toEqual([
      { row: 2, cells: ["jo@example.com", ""] },
      { row: 3, cells: ["", "https://meadow-seed.test"] },
    ]);
  });

  it("takes off a byte order mark and Windows line ends, and skips blank lines but keeps the sheet's row numbers", () => {
    const s = sheet("﻿\r\n\r\nEmail,Name\r\njo@example.com,Jo\r\n\r\n,\r\nkim@example.com,Kim\r\n");
    expect(s.header).toEqual(["Email", "Name"]);
    expect(s.rows).toEqual([
      { row: 2, cells: ["jo@example.com", "Jo"] },
      { row: 5, cells: ["kim@example.com", "Kim"] },
    ]);
  });

  it("reads a fully quoted CSV with CRLF", () => {
    const s = sheet(csvOf([["Email", "First Name"], ["nia@fernhill-plants.test", 'Nia "Plants"']]));
    expect(s.rows[0]!.cells).toEqual(["nia@fernhill-plants.test", 'Nia "Plants"']);
  });

  it("pads short rows, drops cells past the header, and leaves out a cell over 2,000 characters", () => {
    const long = "x".repeat(PASTE_LIMITS.cellChars + 1);
    const s = sheet(`Email,Name,Notes\njo@example.com\nkim@example.com,Kim,${long},extra\nlee@example.com,Lee,${"y".repeat(PASTE_LIMITS.cellChars)}`);
    expect(s.rows[0]!.cells).toEqual(["jo@example.com", "", ""]);
    expect(s.rows[1]!.cells).toEqual(["kim@example.com", "Kim", null]);
    expect(s.rows[2]!.cells[2]).toHaveLength(PASTE_LIMITS.cellChars);
  });

  it("refuses nothing, or a header with no rows, as empty", () => {
    expect(parseSheet("")).toEqual({ ok: false, error: "empty" });
    expect(parseSheet("  \n\t\n")).toEqual({ ok: false, error: "empty" });
    expect(parseSheet("Email\tName\n\n")).toEqual({ ok: false, error: "empty", header: ["Email", "Name"] });
  });

  it("refuses 51 data rows, 41 columns and 200,001 characters", () => {
    const rows = (n: number) => ["Email", ...Array.from({ length: n }, (_, i) => `p${i}@example.com`)].join("\n");
    expect(parseSheet(rows(50)).ok).toBe(true);
    expect(parseSheet(rows(51))).toEqual({ ok: false, error: "too_many_rows" });
    // Blank lines don't count towards the 50.
    expect(parseSheet(rows(50) + "\n\n\n").ok).toBe(true);
    const cols = (n: number) => `${Array.from({ length: n }, (_, i) => `Column ${i}`).join(",")}\n${"a,".repeat(n - 1)}a`;
    expect(parseSheet(cols(40)).ok).toBe(true);
    expect(parseSheet(cols(41))).toEqual({ ok: false, error: "too_many_columns" });
    expect(parseSheet(`Email\n${"x".repeat(PASTE_LIMITS.textChars)}`)).toEqual({ ok: false, error: "too_long" });
  });
});
