/**
 * Made-up pasted lists for the paste tests. Every person, firm and address here is invented, at
 * example.com or a .test domain: no real people, and no rows from any real list.
 */

/** A list shaped like a public investor kit's columns (no emails), copied from a sheet with tabs. */
export const KIT_HEADER = [
  "First Name",
  "Last Name",
  "Company Name",
  "Website",
  "Person Linkedin Url",
  "Company Linkedin Url",
  "Title",
  "Investor City",
  "Investor State",
  "Investor's Country",
  "Stages",
  "Sectors",
  "Fund HQ",
  "Num Lead Investments",
  "Total Number of Investments",
  "Recent Investments",
] as const;

export const KIT_ROWS = [
  ["Ada", "Example", "Northfield Ventures", "https://northfield-ventures.test", "https://www.linkedin.com/in/ada-example", "https://www.linkedin.com/company/northfield-ventures", "Partner", "Leeds", "West Yorkshire", "United Kingdom", "Seed, Series A", "Climate, Food", "Leeds", "12", "40", "Acme Oats"],
  ["Ben", "Sample", "Northfield Ventures", "northfield-ventures.test", "https://www.linkedin.com/in/ben-sample", "https://www.linkedin.com/company/northfield-ventures", "Principal", "York", "North Yorkshire", "United Kingdom", "Seed", "Climate", "Leeds", "12", "40", "Acme Oats"],
  ["Cara", "Test", "Harbour Lane Capital", "www.harbour-lane.test/about", "https://www.linkedin.com/in/cara-test", "", "Managing Partner", "Bristol", "", "United Kingdom", "Pre-seed", "Retail", "Bristol", "3", "9", ""],
  ["Dev", "Person", "Quayside Fund", "https://quayside-fund.test/", "", "", "Associate", "Cardiff", "", "Wales", "Series A; Series B", "Health", "Cardiff", "1,204", "2,310", ""],
  ["Eli", "Nolink", "Linked Only", "https://www.linkedin.com/company/linked-only", "", "", "Partner", "Bath", "", "United Kingdom", "Seed", "Food", "Bath", "", "", ""],
  ["Fay", "Noweb", "No Site Partners", "", "", "", "Partner", "Hull", "", "United Kingdom", "Seed", "", "", "", "", ""],
] as const;

export const KIT_TSV = [KIT_HEADER, ...KIT_ROWS].map((r) => r.join("\t")).join("\n");

/** The "done when" list: 10 people with emails, 3 firms with only a web address, and a name only. */
export const DONE_WHEN_HEADER = ["First Name", "Last Name", "Email", "Company Name", "Website"] as const;
export const DONE_WHEN_ROWS = [
  ["Jo", "Example", "jo@northfield-ventures.test", "Northfield Ventures", ""],
  ["Kim", "Sample", "kim@harbour-lane.test", "Harbour Lane Capital", ""],
  ["Lee", "Test", "lee@example.com", "", ""],
  ["Mo", "Person", "mo@quayside-fund.test", "Quayside Fund", ""],
  ["Nia", "Example", "nia@fernhill-plants.test", "Fernhill Plants", ""],
  ["Oli", "Sample", "oli@example.com", "", ""],
  ["Pat", "Test", "pat@riverbank-bank.test", "Riverbank Bank", ""],
  ["Raj", "Person", "raj@example.com", "", ""],
  ["Sue", "Example", "sue@greenleaf-grants.test", "Greenleaf Grants", ""],
  ["Tom", "Sample", "tom@example.com", "", ""],
  ["", "", "", "Meadow Seed Fund", "https://meadow-seed.test"],
  ["", "", "", "Oak Lane Lenders", "oak-lane-lenders.test"],
  ["", "", "", "Cobble Street Capital", "www.cobble-street.test"],
  ["Una", "Nameonly", "", "", ""],
] as const;

export const DONE_WHEN_TSV = [DONE_WHEN_HEADER, ...DONE_WHEN_ROWS].map((r) => r.join("\t")).join("\n");

/** A CSV built from rows, quoting every cell RFC 4180's way. */
export function csvOf(rows: ReadonlyArray<ReadonlyArray<string>>, delimiter = ","): string {
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(delimiter)).join("\r\n");
}
