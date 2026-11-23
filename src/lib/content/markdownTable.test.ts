import { describe, expect, it } from "vitest";
import { isTableStart, readTable, splitRow } from "./markdownTable";

describe("markdownTable", () => {
  it("splits a row into cells, keeping an escaped pipe as text", () => {
    expect(splitRow("| a | b \\| c | d |")).toEqual(["a", "b | c", "d"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    expect(splitRow("| ends in a pipe \\|")).toEqual(["ends in a pipe |"]);
  });

  it("starts a table only at a header row with a matching separator row", () => {
    expect(isTableStart(["| a | b |", "| --- | :-: |"], 0)).toBe(true);
    expect(isTableStart(["| a | b |", "| --- |"], 0)).toBe(false);
    expect(isTableStart(["| a | b |"], 0)).toBe(false);
    expect(isTableStart(["a | b", "text"], 0)).toBe(false);
    expect(isTableStart(["one", "---"], 0)).toBe(false);
  });

  it("reads the header, each column's alignment, rows at the header's width and where it ends", () => {
    const lines = ["Intro", "| Page | Clicks | Share | Note |", "| :--- | ---: | :-: | --- |", "| / | 12 | 50% |", "| /a | 3 | 1% | x | extra |", "", "After"];
    expect(readTable(lines, 0)).toBeNull();
    expect(readTable(lines, 1)).toEqual({
      header: ["Page", "Clicks", "Share", "Note"],
      align: ["left", "right", "center", null],
      rows: [
        ["/", "12", "50%", ""],
        ["/a", "3", "1%", "x"],
      ],
      next: 5,
    });
  });

  it("ends a table at a line with no pipe", () => {
    expect(readTable(["| a | b |", "| - | - |", "| 1 | 2 |", "no pipe here"], 0)?.next).toBe(3);
  });
});
