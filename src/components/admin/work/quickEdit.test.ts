import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkFilters } from "@/lib/work/inputs";
import type { OpenRow } from "@/lib/work/screens";
import { WORK_COPY } from "@/lib/work/screenWords";
import { DUE, MEMBER, PLAIN, ROWS } from "@/lib/work/testing/screens";

// Work's list with quick edit (WORK_QUICK_EDIT_ENABLED), as it draws. The repo has no browser test
// kit, so clicks and keys are proven through src/lib/work/quickEdit.ts's pure rules; this holds the
// markup: the closed rows, the Ref buttons, the open row and what it holds. Made-up tasks from
// src/lib/work/testing/screens.ts.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/work" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { WorkQuickTable } = await import("./WorkQuickTable");
const { WorkTable } = await import("./WorkTable");

const FILTERS: WorkFilters = { brand: null, stage: null, status: "open", mustHave: false, due: false, kind: null };
const draw = (open: OpenRow | null, o: { multiBrand?: boolean; rows?: typeof ROWS } = {}) =>
  renderToStaticMarkup(
    createElement(WorkQuickTable, { rows: o.rows ?? ROWS, multiBrand: o.multiBrand ?? true, ideaWords: true, filters: FILTERS, brands: [], counts: { mustHave: 2, due: 1 }, open }),
  );
const openDue = (over: Partial<Extract<OpenRow, { kind: "task" }>> = {}): OpenRow => ({ kind: "task", ref: 21, screen: DUE, row: ROWS[0]!, kept: false, ...over });

/** The words a row reads, tags taken out. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Each row of a table, by its role, from its first tag's end. */
const rowsOf = (html: string) =>
  html
    .split('role="row"')
    .slice(2)
    .map((r) => r.slice(r.indexOf(">") + 1));
/** The open row's markup: its panel, up to the next row of the list. */
const panelOf = (html: string) => {
  const from = html.indexOf('<section id="wk-row-panel"');
  const to = html.indexOf("data-row=", from);
  return html.slice(from, to < 0 ? undefined : to);
};

describe("the list's rows with quick edit", () => {
  it("read as today's rows when closed, with a Ref button that says it opens the row", () => {
    const html = draw(null);
    const today = renderToStaticMarkup(createElement(WorkTable, { rows: ROWS, multiBrand: true, ideaWords: true }));
    expect(rowsOf(html).map(text)).toEqual(rowsOf(today).map(text));
    for (const r of ROWS) {
      expect(html).toContain(`aria-expanded="false" data-ref-button="${r.ref}"`);
      expect(html).toContain(`href="/admin/work/${r.ref}"`);
    }
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain('id="wk-row-panel"');
    // The Task column may shrink to 10rem so Check fits a full width window.
    expect(html).toContain("grid-cols-[4rem_minmax(10rem,1fr)_7rem_8rem_9rem_8rem_8rem_10rem]");
    expect(html).toContain(WORK_COPY.listOrder);
    expect(html).not.toContain(WORK_COPY.sortAgain);
  });

  it("mark each cell with the field a click on it opens", () => {
    const html = draw(null);
    for (const c of ["ref", "title", "must", "vizzy", "pr", "status", "stage", "brand", "idea", "block", "check"]) expect(html, c).toContain(`data-cell="${c}"`);
    expect(html).toContain('data-wait="18"');
    expect(draw(null, { multiBrand: false })).not.toContain('data-cell="brand"');
  });
});

describe("the open row", () => {
  const html = draw(openDue());
  const panel = panelOf(html);

  it("opens under its own row, one cell spanning every column, and its Ref button says so", () => {
    expect(html).toContain('aria-expanded="true" aria-controls="wk-row-panel" data-ref-button="21"');
    expect(html).toContain('<div role="cell" aria-colspan="8" class="col-span-full min-w-0">');
    expect(html.indexOf('data-row="21"')).toBeLessThan(html.indexOf('id="wk-row-panel"'));
    expect(html.indexOf('id="wk-row-panel"')).toBeLessThan(html.indexOf('data-row="30"'));
  });

  it("has its heading, the status line that is always there, Open the full page and Close", () => {
    expect(panel).toContain('aria-labelledby="wk-row-panel-h"');
    expect(panel).toMatch(/<h2 id="wk-row-panel-h" tabindex="-1"[^>]*><span class="sr-only">Task #21 <\/span>/);
    expect(panel).toContain(">Templates for team notes</button>");
    expect(panel).toMatch(/<p role="status" aria-live="polite"[^>]*><\/p>/);
    expect(panel).toContain('href="/admin/work/21"');
    expect(panel).toContain(WORK_COPY.openFull);
    expect(panel).toContain('aria-label="Close task #21"');
    expect(panel).toContain(`title="${WORK_COPY.closeRowHint}"`);
  });

  it("puts the quick fields first, in the columns' order, then the rest of the task's page", () => {
    const band = panel.indexOf('role="group" aria-label="Quick fields"');
    expect(band).toBeGreaterThan(-1);
    // Narrower than 900px (as drawn before the list is measured) it stacks, How we'll know it worked after the notes.
    const marks = [
      ">Status</p>",
      ">Stage</span>",
      ">Brand</span>",
      ">Idea</p>",
      ">Blocked by</p>",
      ">Check</p>",
      ">Must have</span>",
      ">Description</p>",
      ">Notes</p>",
      ">How we&#x27;ll know it worked</h2>",
      ">Links</h2>",
      ">Decisions</h2>",
      ">History</h2>",
      ">Delete task</button>",
    ];
    const at = marks.map((m) => {
      const i = panel.indexOf(m, band);
      expect(i, m).toBeGreaterThan(band);
      return i;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("has everything the task's page has: the due check, the blockers, links, decisions, History and Delete", () => {
    for (const s of [
      "Check due: did it work?",
      "Better",
      "Too soon to tell",
      "#18 Template gallery page",
      WORK_COPY.deletedTask,
      "Templates plan",
      "NOTE_TEMPLATES_ENABLED",
      "Ideas from the chat",
      "Which templates first?",
      "Agreed with Vizzy",
      "What Vizzy suggested",
      "npm run check:templates",
      "Sam writes the meeting one.",
      "Record a decision",
      WORK_COPY.taskRegionsDown.replace(/'/g, "&#x27;"),
    ])
      expect(panel, s).toContain(s);
    // History shows the newest 5 of 6, with Show all.
    expect(panel).toContain("Newest 5 of 6");
    expect(panel).toContain(WORK_COPY.showAll);
    // No drafts in the row: Vizzy's drafted decisions still open the full page.
    expect(panel).not.toContain("Leave it");
  });

  it("repeats no id, so one open row keeps them unique", () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers Delete only to admins and owners", () => {
    expect(panel).toContain("Delete task");
    expect(panel).toContain(WORK_COPY.adminsOnly);
    const member = panelOf(draw({ kind: "task", ref: 30, screen: MEMBER, row: ROWS[1]!, kept: false }, { multiBrand: false }));
    expect(member).toContain("Interview 5 team admins");
    expect(member).not.toContain("Delete task");
    expect(member).not.toContain('aria-label="Brand"');
  });

  it("keeps a row the filters no longer show, with the note, and shows one opened from elsewhere on top", () => {
    const kept = draw(openDue({ kept: true }));
    expect(kept).toContain(WORK_COPY.keptNote.replace(/'/g, "&#x27;"));
    expect(html).not.toContain(WORK_COPY.keptNote.replace(/'/g, "&#x27;"));
    // Opened from elsewhere: not one of the list's rows, so it comes first, with its note.
    const plain = { ...ROWS[2]!, id: PLAIN.page.task.id };
    const elsewhere = draw({ kind: "task", ref: 3, screen: PLAIN, row: plain, kept: true }, { rows: ROWS.slice(0, 2) });
    expect(elsewhere.indexOf('data-row="3"')).toBeLessThan(elsewhere.indexOf('data-row="21"'));
    expect(elsewhere).toContain(WORK_COPY.keptNote.replace(/'/g, "&#x27;"));
    // The list shows when the kept row was its only one, not No tasks match.
    const only = draw({ kind: "task", ref: 3, screen: PLAIN, row: plain, kept: true }, { rows: [] });
    expect(only).toContain('data-row="3"');
    expect(only).not.toContain(WORK_COPY.noMatch);
    expect(draw(null, { rows: [] })).toContain(WORK_COPY.noMatch);
  });

  it("says there's no task with that number, or that its region didn't answer, with Close", () => {
    const none = draw({ kind: "none", ref: 999 });
    expect(none).toContain(WORK_COPY.noSuchTask.replace(/'/g, "&#x27;"));
    expect(none).toContain(">Close<");
    const unread = draw({ kind: "unread", ref: 12, regions: ["Europe"] });
    expect(unread).toContain("Work couldn&#x27;t read the tasks kept in Europe just now");
  });
});
