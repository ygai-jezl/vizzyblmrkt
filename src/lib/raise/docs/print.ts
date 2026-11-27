/**
 * Save as PDF: the browser's own print window, with one 16:9 slide a page. The print root holds
 * every slide at 1280 by 720 CSS pixels, which is 13.333 by 7.5 inches at 96 to the inch, so each
 * page is exactly one slide with no margin. Text stays real text, so whoever reads the PDF can
 * search and copy it. Everything else on the page is hidden while printing. Pure and client safe.
 */

/** The print root's id: a portal on document.body while the print window is open. */
export const PRINT_ROOT_ID = "raise-print-root";

/** One slide's page in the print root. */
export const PRINT_SLIDE_CLASS = "rd-print-slide";

export const DECK_PRINT_CSS = [
  "@page { size: 13.333in 7.5in; margin: 0; }",
  "@media print {",
  // The admin's own layout can fix the page's height or hide its overflow: neither may cut pages off.
  `  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #FFFFFF !important; }`,
  `  body > :not(#${PRINT_ROOT_ID}) { display: none !important; }`,
  `  #${PRINT_ROOT_ID} { display: block; }`,
  `  .${PRINT_SLIDE_CLASS} { width: 13.333in; height: 7.5in; overflow: hidden; break-after: page; page-break-after: always; break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
  `  .${PRINT_SLIDE_CLASS}:last-child { break-after: auto; page-break-after: auto; }`,
  "}",
  `@media screen { #${PRINT_ROOT_ID} { display: none; } }`,
].join("\n");
