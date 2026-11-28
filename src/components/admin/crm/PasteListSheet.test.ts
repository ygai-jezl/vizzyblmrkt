import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { KIT_URL, PUBLIC_LIST } from "@/lib/crm/paste/publicLists";
import { PASTE_NOTES, PASTE_WORDS } from "@/lib/crm/paste/words";
import type { AgentActionId } from "@/lib/types/agentAction";
import { pastedLine } from "./CompanyDetail";
import { PasteDone, PasteListSheet, PastePreview } from "./PasteListSheet";
import { PublicListCard } from "./PublicListCard";
import type { PasteBatchView } from "./pasteApi";

/** What the sheet draws before anyone types, and once a list is read: made-up people and firms at .test. */

const noop = () => undefined;
// React escapes apostrophes in text as &#x27;.
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const VIEW: PasteBatchView = {
  id: "aa_0123456789abcdef0123456789abcdef" as AgentActionId,
  rev: 1,
  expiresAt: "2026-12-03T10:00:00.000Z",
  source: "A local lenders list",
  rows: [
    { row: 2, kind: "person", name: "Nia Example", contact: "nia@fernhill-plants.test", fields: 1 },
    { row: 3, kind: "company", name: "Northfield Ventures", contact: "northfield-ventures.test", fields: 2 },
  ],
  counts: { read: 4, people: 1, companies: 1, left: 1, already: 1 },
  columns: { read: [{ header: "Email", as: "Email" }, { header: "Website", as: "Web address" }], left: ["Person Linkedin Url"] },
  notes: ["firms_left_out", "profile_links"],
};

describe("PasteListSheet", () => {
  it("opens on the box: the lead, the rows, where the list is from, and the public list folded", () => {
    const out = html(createElement(PasteListSheet, { open: true, onClose: noop }));
    for (const w of [PASTE_WORDS.lead, PASTE_WORDS.anyList, PASTE_WORDS.rowsLabel, PASTE_WORDS.rowsHint, PASTE_WORDS.sourceLabel, PASTE_WORDS.sourceHint, PASTE_WORDS.read, PUBLIC_LIST.summary]) {
      expect(out).toContain(w);
    }
    expect(out).toContain('maxLength="200000"');
    expect(out).toContain('maxLength="80"');
    expect(out).not.toMatch(/<details[^>]* open/);
    expect(html(createElement(PasteListSheet, { open: true, onClose: noop, openPublicList: true }))).toMatch(/<details[^>]* open/);
  });

  it("opened on a waiting list, loads it before showing anything", () => {
    const out = html(createElement(PasteListSheet, { open: true, onClose: noop, batchId: VIEW.id }));
    expect(out).toContain("Loading");
    expect(out).not.toContain(PASTE_WORDS.read);
  });

  it("draws nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(PasteListSheet, { open: false, onClose: noop }))).toBe("");
  });
});

describe("PastePreview", () => {
  const preview = (skipped: Parameters<typeof PastePreview>[0]["skipped"]) =>
    html(createElement(PastePreview, { view: VIEW, skipped, warning: null, busy: false, onAdd: noop, onDismiss: noop }));

  it("shows each row it adds and as what, how each column was read, the notes and the add button", () => {
    const out = preview([{ row: 4, reason: "no_contact" }, { row: 5, reason: "in_companies" }]);
    expect(out).toContain("Read 4 rows: 1 person and 1 company to add, 2 left out.");
    expect(out).toContain("Where it's from: A local lenders list");
    for (const w of [PASTE_WORDS.tableRow, PASTE_WORDS.tableAdds, PASTE_WORDS.tableName, PASTE_WORDS.tableContact, "Person", "Company", "Nia Example", "nia@fernhill-plants.test", "northfield-ventures.test"]) {
      expect(out).toContain(w);
    }
    expect(out).toContain("Website as Web address");
    expect(out).toContain("Person Linkedin Url");
    expect(out).toContain("Row 4: Needs an email, a phone or a web address");
    expect(out).toContain("Row 5: Already in Companies");
    for (const n of [PASTE_NOTES.firms_left_out, PASTE_NOTES.profile_links, PASTE_NOTES.not_yet]) expect(out).toContain(n);
    expect(out).toContain("Add 1 person and 1 company");
    expect(out).toContain(PASTE_WORDS.dismiss);
    expect(out).toContain(PASTE_WORDS.waits);
  });

  it("opened from Review, says how many rows were left out instead of which", () => {
    const out = preview(null);
    expect(out).toContain("2 rows were left out when the list was read.");
    expect(out).not.toContain("Row 4:");
  });

  it("says Adding while the add runs, and shows the plan's people warning", () => {
    const out = html(createElement(PastePreview, { view: VIEW, skipped: [], warning: "You're near your plan's people.", busy: true, adding: true, onAdd: noop, onDismiss: noop }));
    expect(out).toContain(PASTE_WORDS.adding);
    expect(out).toContain("You're near your plan's people.");
  });

  it("keeps to house style: no dashes as punctuation and no AI tells", () => {
    const text = (s: string) => s.replace(/<[^>]+>/g, "\n");
    for (const out of [preview([{ row: 4, reason: "no_contact" }]), preview(null), html(createElement(PasteListSheet, { open: true, onClose: noop }))]) {
      for (const line of text(out).split("\n")) expect([...dashesIn(line), ...aiTellsIn(line)], line).toEqual([]);
    }
  });
});

describe("PasteDone", () => {
  it("says who was added and who was already here", () => {
    const out = html(createElement(PasteDone, { result: { added: { people: 10, companies: 3 }, already: { people: 2, companies: 0 }, fieldsNotSaved: 0 }, onDone: noop }));
    expect(out).toContain("Added 10 people and 3 companies. Each timeline says where the list is from.");
    expect(out).toContain("2 were already here, so they were left as they are.");
    expect(out).toContain(PASTE_WORDS.done);
  });
});

describe("PublicListCard", () => {
  it("credits the kit's makers and links out to the original, in a new tab with no opener", () => {
    const out = html(createElement(PublicListCard));
    expect(out).toContain(PUBLIC_LIST.title);
    expect(out).toContain(PUBLIC_LIST.credit);
    expect(out).toContain(`href="${KIT_URL}"`);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    for (const o of PUBLIC_LIST.others) expect(out).toContain(`href="${o.url}"`);
    for (const g of PUBLIC_LIST.guidance) expect(out).toContain(g);
    expect(out).toContain(PUBLIC_LIST.footnote);
    expect(html(createElement(PublicListCard, { heading: false }))).not.toContain(`>${PUBLIC_LIST.title}<`);
  });
});

describe("a company from a pasted list", () => {
  it("says when it was added and where the list is from, and nothing for any other company", () => {
    const line = pastedLine({ addedBy: { kind: "member", id: "usr_1", at: "2026-11-26T10:00:00.000Z", via: "paste", source: "A friend's sheet" } });
    expect(line).toMatch(/^Added from a pasted list on .*26 Nov.*\. Where it's from: A friend's sheet\.$/);
    expect(pastedLine({ addedBy: undefined })).toBeNull();
    expect(pastedLine({ addedBy: { kind: "member", id: "usr_1", at: "2026-11-26T10:00:00.000Z", via: "form" } })).toBeNull();
  });
});
