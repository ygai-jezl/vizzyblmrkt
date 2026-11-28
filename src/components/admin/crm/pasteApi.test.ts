import { describe, expect, it } from "vitest";
import { COMPANY_REMOVE, PASTE_MESSAGES, PASTE_NOTES } from "@/lib/crm/paste/words";
import {
  addedLines,
  checkBox,
  columnChip,
  kindWord,
  noteLines,
  pasteError,
  removeError,
  skippedLines,
  viewSummary,
  withoutPaste,
  type PasteBatchView,
} from "./pasteApi";

const counts = (c: Partial<PasteBatchView["counts"]>): Pick<PasteBatchView, "counts"> => ({ counts: { read: 0, people: 0, companies: 0, left: 0, already: 0, ...c } });

describe("the Paste a list sheet's words", () => {
  it("sum up a read list for one, many and none, counting rows already here as left out", () => {
    expect(viewSummary(counts({ read: 13, people: 10, companies: 3, left: 1 }))).toBe("Read 13 rows: 10 people and 3 companies to add, 1 left out.");
    expect(viewSummary(counts({ read: 1, people: 1 }))).toBe("Read 1 row: 1 person to add.");
    expect(viewSummary(counts({ read: 4, companies: 1, left: 1, already: 2 }))).toBe("Read 4 rows: 1 company to add, 3 left out.");
    expect(viewSummary(counts({ read: 0 }))).toBe("Read 0 rows.");
  });

  it("say each skipped row by its number and reason, in row order, never a cell", () => {
    expect(
      skippedLines([
        { row: 9, reason: "in_people" },
        { row: 7, reason: "no_contact" },
      ]),
    ).toEqual(["Row 7: Needs an email, a phone or a web address", "Row 9: Already in People"]);
  });

  it("turn a route's error code into its words, and anything else into That didn't work", () => {
    expect(pasteError({ data: { error: "source_needed" } })).toBe(PASTE_MESSAGES.source_needed);
    expect(pasteError({ data: { error: "paste_gone" } })).toBe(PASTE_MESSAGES.paste_gone);
    expect(pasteError({ data: { error: "too_long" } })).toBe(PASTE_MESSAGES.too_long);
    expect(pasteError({ data: { error: "network" } })).toBe(PASTE_MESSAGES.failed);
    expect(pasteError({ data: { error: "toString" } })).toBe(PASTE_MESSAGES.failed);
    expect(pasteError({ data: null })).toBe(PASTE_MESSAGES.failed);
  });

  it("check the box before it sends: rows first, then where they are from", () => {
    expect(checkBox("  ", "")).toBe("empty");
    expect(checkBox("Email\nnia@fernhill-plants.test", " \n ")).toBe("source_needed");
    expect(checkBox("Email\nnia@fernhill-plants.test", "A local lenders list")).toBeNull();
  });

  it("show a header once when it was read as itself, and both when it was read as something else", () => {
    expect(columnChip({ header: "Email", as: "Email" })).toBe("Email");
    expect(columnChip({ header: "Website", as: "Web address" })).toBe("Website as Web address");
    expect(kindWord("person")).toBe("Person");
    expect(kindWord("company")).toBe("Company");
  });

  it("add Not yet to the notes only when the list adds people", () => {
    expect(noteLines({ notes: ["firms_left_out", "profile_links"], ...counts({ people: 2 }) })).toEqual([PASTE_NOTES.firms_left_out, PASTE_NOTES.profile_links, PASTE_NOTES.not_yet]);
    expect(noteLines({ notes: ["firms_left_out"], ...counts({ companies: 3 }) })).toEqual([PASTE_NOTES.firms_left_out]);
  });

  it("say who was added, who was already here, and values that didn't save", () => {
    expect(addedLines({ added: { people: 10, companies: 3 }, already: { people: 0, companies: 0 }, fieldsNotSaved: 0 })).toEqual([
      "Added 10 people and 3 companies. Each timeline says where the list is from.",
    ]);
    expect(addedLines({ added: { people: 8, companies: 3 }, already: { people: 2, companies: 0 }, fieldsNotSaved: 1 })).toEqual([
      "Added 8 people and 3 companies. Each timeline says where the list is from.",
      "2 were already here, so they were left as they are.",
      PASTE_NOTES.values_left_out,
    ]);
  });

  it("say why a company can't be removed", () => {
    expect(removeError({ data: { error: "has_people" } })).toBe(COMPANY_REMOVE.has_people);
    expect(removeError({ data: { error: "not_found" } })).toBe(COMPANY_REMOVE.failed);
  });

  it("drop only ?paste= from the address once the sheet closes, keeping the tab", () => {
    expect(withoutPaste("/admin/crm", "?paste=aa_123")).toBe("/admin/crm");
    expect(withoutPaste("/admin/crm", "?tab=companies&paste=aa_123")).toBe("/admin/crm?tab=companies");
    expect(withoutPaste("/admin/crm", "")).toBe("/admin/crm");
  });
});
