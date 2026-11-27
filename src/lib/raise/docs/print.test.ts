import { describe, expect, it } from "vitest";
import { DECK_PRINT_CSS, PRINT_ROOT_ID, PRINT_SLIDE_CLASS } from "./print";

describe("the print stylesheet for Save as PDF", () => {
  it("makes each page one 16:9 slide, 13.333 by 7.5 inches, with no margin", () => {
    expect(DECK_PRINT_CSS).toContain("@page { size: 13.333in 7.5in; margin: 0; }");
    expect(DECK_PRINT_CSS).toContain(`.${PRINT_SLIDE_CLASS} { width: 13.333in; height: 7.5in; overflow: hidden;`);
  });

  it("breaks after every slide but the last, and keeps the colours exact", () => {
    expect(DECK_PRINT_CSS).toContain("break-after: page; page-break-after: always;");
    expect(DECK_PRINT_CSS).toContain(`.${PRINT_SLIDE_CLASS}:last-child { break-after: auto;`);
    expect(DECK_PRINT_CSS).toContain("-webkit-print-color-adjust: exact; print-color-adjust: exact;");
  });

  it("prints only the print root, and never shows it on screen", () => {
    expect(PRINT_ROOT_ID).toBe("raise-print-root");
    expect(DECK_PRINT_CSS).toContain("body > :not(#raise-print-root) { display: none !important; }");
    expect(DECK_PRINT_CSS).toContain("#raise-print-root { display: block; }");
    expect(DECK_PRINT_CSS).toContain("@media screen { #raise-print-root { display: none; } }");
  });
});
