import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AddScreen } from "@/lib/work/screens";
import type { WorkRow } from "@/lib/work/list";
import type { ImportPreview } from "@/lib/work/service";
import { blankMeasure, blankPart, typedLinkWords } from "@/lib/work/form";
import { changeWords, checkSaidLine, noLinksText, regionsFullText } from "@/lib/work/screenWords";
import { suggestMeasureKind } from "@/lib/work/measureKind";
import type { WorkLogRowOf } from "@/lib/work/types";

// Work's screens as they draw. Made-up Lumen Notes and Fernhill Plants.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/work" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { typedKinds, TypedLinksEditor } = await import("./TaskFields");
const { checkButtons, checkNoticeOf } = await import("./CheckActions");
const { focusTarget } = await import("./useFocusSwap");
const { decisionView } = await import("./Decisions");
const { movedWords, decisionWords } = await import("./WorkLog");
const { historyLine } = await import("./TaskPage");
const { TaskForm } = await import("./TaskForm");
const { MeasurePicker } = await import("./MeasurePicker");
const { WorkTable } = await import("./WorkTable");
const { PreviewView } = await import("./ImportDialog");

const REPO = { provider: "github" as const, fullPath: "Lumen-Example/notes-app" };
const T = "2026-11-24T16:25:00.000Z";
const SOURCE = { who: { kind: "person" as const, id: "uid_nina" }, tool: "work_page", session: null };
const decision = (over: Partial<WorkLogRowOf<"decision">["decision"]>, id = `wl_${"a".repeat(24)}`): WorkLogRowOf<"decision"> => ({
  id,
  organisationId: "org_ten_lumen",
  brandId: "ten_lumen",
  region: "us",
  day: "2026-11-24",
  at: T,
  source: SOURCE,
  kind: "decision",
  taskId: `wt_${"a".repeat(20)}`,
  decision: {
    question: "Invite by link or by email first?",
    options: [
      { id: "a", label: "By link" },
      { id: "b", label: "By email" },
    ],
    recommended: { option: "a", by: { kind: "vizzy" }, reason: "Fewer steps for the person sharing." },
    chosen: { option: "b", by: "uid_nina" },
    agreed: false,
    why: "Team admins asked to see who joins.",
    replaces: null,
    plan: null,
    ...over,
  },
});

describe("Connected to's kinds", () => {
  it("offer a pull request and a switch only with a connected repo, an idea and a plan to anyone", () => {
    expect(typedKinds({ repos: [REPO], operator: false, loopsRepo: null, links: [] })).toEqual(["pull_request", "switch", "idea", "plan"]);
    expect(typedKinds({ repos: [], operator: false, loopsRepo: null, links: [] })).toEqual(["idea", "plan"]);
  });

  it("offer a loop line only to an operator, beside a pull request from this copy's own repo", () => {
    const pr = [{ kind: "pull_request" as const, provider: "github" as const, repo: "Lumen-Example/Notes-App", number: 84 }];
    expect(typedKinds({ repos: [REPO], operator: true, loopsRepo: "lumen-example/notes-app", links: pr })).toContain("loop_line");
    expect(typedKinds({ repos: [REPO], operator: false, loopsRepo: "lumen-example/notes-app", links: pr })).not.toContain("loop_line");
    expect(typedKinds({ repos: [REPO], operator: true, loopsRepo: null, links: pr })).not.toContain("loop_line");
    expect(typedKinds({ repos: [REPO], operator: true, loopsRepo: "lumen-example/notes-app", links: [] })).not.toContain("loop_line");
  });
});

describe("the words for an idea while launches are called launches", () => {
  const ideaLink = { kind: "idea" as const, brandId: "ten_lumen", ideaId: "cmp_spaces" };
  const props = { links: [ideaLink], onChange: () => {}, repos: [], ideas: [{ value: "ten_lumen:cmp_other", label: "Team spaces" }], operator: false, loopsRepo: null, ideaName: () => undefined };

  it("say launch everywhere Work names one, never idea", () => {
    const off = renderToStaticMarkup(createElement(TypedLinksEditor, { ...props, ideaWords: false }));
    expect(off).toContain("Pick a launch");
    expect(off).toContain(">Launch<");
    expect(off).toContain("A launch");
    expect(off).toContain("Another launch this task touches.");
    expect(off).toContain("Exact links that agents can follow: a launch, or a plan page.");
    expect(off.replace(/<[^>]*>/g, " ")).not.toMatch(/\bideas?\b/i);
    expect(off).not.toMatch(/aria-label="Idea"/);
    const on = renderToStaticMarkup(createElement(TypedLinksEditor, { ...props, ideaWords: true }));
    expect(on).toContain("Pick an idea");
    expect(on).toContain("Another idea this task touches.");
  });

  it("say launch in history, links with nothing in them and the rule's reason", () => {
    expect(changeWords("ideaId", null, "cmp_spaces")).toBe("made it into a launch");
    expect(changeWords("ideaId", "cmp_spaces", null, { ideaWords: true })).toBe("unlinked its idea");
    expect(changeWords("ideaBrandId", null, "ten_lumen")).toBe("changed the launch's brand");
    expect(noLinksText(false, false)).toBe("No links yet. Add a launch, a plan, an AI chat or a page.");
    expect(noLinksText(true, true)).toBe("No links yet. Add a pull request, a switch, an idea, a plan, an AI chat or a page.");
    expect(typedLinkWords(ideaLink)).toEqual({ label: "A launch", where: "Launch" });
    expect(suggestMeasureKind({ title: "Plan the spring stall", typedLinks: [ideaLink] })?.reason).toBe("It serves a launch, so the win is a number that moves for it.");
  });
});

describe("a check's buttons", () => {
  it("are the four reads on a measure's check, and Mark checked and Look again on any other", () => {
    expect(checkButtons(true, null).map((b) => b.label)).toEqual(["Better", "Same", "Worse", "Too soon to tell"]);
    expect(checkButtons(false, null).map((b) => b.label)).toEqual(["Mark checked", "Look again tomorrow"]);
    expect(checkButtons(true, "too_soon")).toEqual([
      { key: "better", label: "Better", disabled: true },
      { key: "same", label: "Same", disabled: true },
      { key: "worse", label: "Worse", disabled: true },
      { key: "too_soon", label: "Saving…", disabled: true },
    ]);
  });
});

describe("a check's answer", () => {
  it("is kept where the page holds it, saying what Work set next, since the answered check leaves the page", () => {
    expect(checkNoticeOf("It asks again on 3 Dec at 08:00.")).toBe("It asks again on 3 Dec at 08:00.");
    expect(checkNoticeOf(null)).toBe("Checked.");
    // On Today, with the task it was about.
    expect(checkSaidLine(12, "It asks again on 3 Dec at 08:00.")).toBe("#12: It asks again on 3 Dec at 08:00.");
  });
});

describe("a button that opens its own form", () => {
  it("moves focus into the form when it opens, back to the button when it closes, and nowhere otherwise", () => {
    expect(focusTarget(false, true)).toBe("form");
    expect(focusTarget(true, false)).toBe("opener");
    expect(focusTarget(false, false)).toBeNull();
    expect(focusTarget(true, true)).toBeNull();
  });
});

describe("a region holding more tasks than Work reads", () => {
  it("is named on the list", () => {
    expect(regionsFullText(["United States"])).toBe("Work reads up to 5,000 tasks in each region, and United States holds more, so some are missing here. Delete done or dropped tasks you no longer need.");
  });
});

describe("decisions", () => {
  const o = { me: "uid_nina", names: { uid_sam: "Sam" }, timeZone: "Europe/London", today: "2026-11-25", typedLinks: [], replacedIds: new Set<string>() };

  it("show where a person overruled Vizzy's pick, with both reasons", () => {
    const v = decisionView(decision({}), o);
    expect(v).toMatchObject({ verdict: "Overruled Vizzy", tone: "amber", when: "24 Nov, 16:25", isPlan: false, replaced: false });
    expect(v.recommendation).toEqual({ text: "Vizzy recommended “By link”.", why: "Fewer steps for the person sharing.", vizzy: true });
    expect(v.choice).toMatchObject({ text: "You chose “By email”.", why: "Team admins asked to see who joins." });
    expect(decisionView(decision({ chosen: { option: "a", by: "uid_sam" }, agreed: true }), o)).toMatchObject({ verdict: "Agreed with Vizzy", choice: { text: "Sam chose “By link”." } });
  });

  it("show a plan approval with the plan and version it approves, and no recommendation", () => {
    const plan = decision({
      question: "Approve the plan",
      options: [
        { id: "a", label: "Approve" },
        { id: "b", label: "Change it" },
        { id: "c", label: "Not now" },
      ],
      recommended: null,
      chosen: { option: "a", by: "uid_nina" },
      agreed: null,
      why: null,
      plan: { url: "https://docs.example.com/plan", version: "2" },
    });
    const v = decisionView(plan, { ...o, typedLinks: [{ kind: "plan", url: "https://docs.example.com/plan", title: "Shared notebooks plan", version: "2" }] });
    expect(v).toMatchObject({ verdict: "Approved", tone: "green", plan: "Shared notebooks plan, version 2", isPlan: true });
    expect(v.recommendation?.text).toBe("No one recommends approving a plan. People keep this gate.");
  });

  it("mark a pick a later row changed, and the Log says each decision in a line", () => {
    const first = decision({});
    expect(decisionView(first, { ...o, replacedIds: new Set([first.id]) }).replaced).toBe(true);
    expect(decisionWords(first, { me: "uid_sam", names: { uid_nina: "Nina" } })).toBe("By email, by Nina. Vizzy's pick was By link.");
    expect(decisionWords(decision({ chosen: null, agreed: null }), o)).toBe("No pick yet.");
  });
});

describe("history and the Log's moves", () => {
  it("say who changed what, and where an imported task came from", () => {
    const origin = { kind: "import" as const, by: "uid_nina", importId: "wi_0123456789abcdef", row: 4, file: "Backlog.csv" };
    const o = { me: "uid_nina", names: {}, origin, brandName: () => undefined, timeZone: "Europe/London", today: "2026-11-25" };
    expect(historyLine({ at: "2026-11-02T17:31:00.000Z", field: "added", who: { kind: "person", id: "uid_nina" } }, o)).toEqual({ who: "You", what: "imported it from Backlog.csv", when: "2 Nov, 17:31", vizzy: false });
    expect(historyLine({ at: "2026-11-25T09:50:00.000Z", field: "status", who: { kind: "person", id: "uid_sam" }, before: "todo", after: "in_progress" }, { ...o, names: { uid_sam: "Sam" } })).toMatchObject({ who: "Sam", what: "moved it from To do to In progress", when: "Today, 09:50" });
    // A measure, clipping or check set keeps no value on the recent list (too big), which isn't a clear (null).
    const at = "2026-11-25T10:00:00.000Z";
    const who = { kind: "person" as const, id: "uid_nina" };
    expect(historyLine({ at, field: "measure", who, before: null }, o).what).toBe("set how we'll know it worked");
    expect(historyLine({ at, field: "measure", who, after: null }, o).what).toBe("took off how we'll know it worked");
    expect(historyLine({ at, field: "clipping", who, before: null }, o).what).toBe("linked a clipping");
    expect(historyLine({ at, field: "clipping", who, after: null }, o).what).toBe("took off the clipping");
    expect(historyLine({ at, field: "check", who, before: null }, o).what).toBe("set the check");
    expect(historyLine({ at, field: "check", who, after: null }, o).what).toBe("cleared the check");
    const moved = {
      taskId: `wt_${"a".repeat(20)}`,
      at: T,
      rows: [
        { id: `wl_${"b".repeat(24)}`, organisationId: "org_ten_lumen", brandId: "ten_lumen", region: "us" as const, day: "2026-11-24", at: T, source: SOURCE, kind: "change" as const, taskId: `wt_${"a".repeat(20)}`, field: "status" as const, before: "todo", after: "done" },
        { id: `wl_${"c".repeat(24)}`, organisationId: "org_ten_lumen", brandId: "ten_lumen", region: "us" as const, day: "2026-11-24", at: T, source: { ...SOURCE, who: { kind: "person" as const, id: "uid_sam" } }, kind: "check" as const, taskId: `wt_${"a".repeat(20)}`, check: { action: "read" as const, kind: "date" as const, at: T, next: null, measureKind: "runs_better" as const, which: "first" as const, counted: null, read: "better" as const } },
      ],
    };
    expect(movedWords(moved, { me: "uid_nina", names: { uid_sam: "Sam" }, brandName: () => undefined })).toBe("You moved it from To do to Done; Sam read the check: Better.");
  });
});

const screen: Pick<AddScreen, "nextRef" | "defaultBrandId" | "options" | "multiBrand" | "oneBrand" | "sessionBrand" | "ideaWords"> = {
  nextRef: 81,
  ideaWords: true,
  defaultBrandId: "ten_lumen",
  multiBrand: true,
  oneBrand: false,
  sessionBrand: { id: "ten_lumen", name: "Lumen Notes" },
  options: {
    brands: [
      { id: "ten_lumen", name: "Lumen Notes", region: "us", timeZone: "Europe/London", today: "2026-11-25", repos: [REPO], products: [{ id: "pc_lumen", name: "Lumen app", events: [{ name: "note_from_template", label: "Notes made from a template" }] }], word: "Sign ups" },
      { id: "ten_lumen-eu", name: "Lumen Europe", region: "eu", timeZone: "Europe/Berlin", today: "2026-11-25", repos: [], products: [], word: null },
    ],
    wholeBusiness: true,
    ideas: [],
    openTasks: [{ ref: 75, title: "Credits and pricing page", status: "in_progress" }],
    meanings: ["conversions", "openRate"],
    operator: false,
    loopsRepo: null,
  },
};

describe("the add page's form", () => {
  it("starts with the next ref, the session brand, Connected to with a repo, and the rule's kind for a brand's task", () => {
    const html = renderToStaticMarkup(createElement(TaskForm, { screen }));
    expect(html).toContain("It becomes #81 when you add it.");
    expect(html).toContain("Pull request");
    expect(html).toContain("Whole business");
    expect(html).toContain("Everyone on Lumen Notes sees it.");
    expect(html).toContain("Suggested: Moves a number. It is for the brand, so the win is a number that moves for the brand.");
    expect(html).toContain("No measure. Pick a kind of win, or leave it for later.");
    expect(html).toContain("When another task is done");
    expect(html).not.toContain("From Vizzy");
    expect(html).toContain("Up to 4,000 characters. Put a command in `backticks` to show it as code.");
  });

  it("says nothing about code in the description for a brand with no repo", () => {
    const html = renderToStaticMarkup(createElement(TaskForm, { screen: { ...screen, defaultBrandId: "ten_lumen-eu" } }));
    expect(html).toContain("Up to 4,000 characters.");
    expect(html).not.toContain("backticks");
  });

  it("opened from a Vizzy suggestion, says so and marks Vizzy's kind", () => {
    const html = renderToStaticMarkup(
      createElement(TaskForm, {
        screen,
        suggestion: {
          actionId: `aa_${"1".repeat(40)}`,
          rev: 1,
          title: "Check the team plan test accounts",
          description: "",
          stage: "build",
          brandId: "ten_lumen",
          typedLinks: [],
          proposed: { kind: "runs_better", reason: "It checks a nightly run." },
          measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
          from: "from today's log",
        },
        cancelHref: "/admin/approvals#work_suggestion",
      }),
    );
    expect(html).toContain("New task from Vizzy");
    expect(html).toContain("From Vizzy&#x27;s suggestion in Review.");
    expect(html).toContain("Vizzy wrote it from today&#x27;s log. What Vizzy wrote is kept beside what you add.");
    expect(html).toContain("Vizzy suggests Runs better. It checks a nightly run.");
    expect(html).toContain('href="/admin/approvals#work_suggestion"');
    // Vizzy's measure fills the picker: Runs better, errors, 7 days after it's done.
    expect(html).toMatch(/<option value="errors" selected="">/);
    expect(html).toMatch(/value="7"/);
  });
});

describe("the measure picker", () => {
  const base = { onChange: () => {}, meanings: ["conversions" as const], operator: false, runsInApp: true, word: "Orders", idPrefix: "t" };

  it("marks the suggested kind with its reason, and the brand's connected product's events", () => {
    const html = renderToStaticMarkup(createElement(MeasurePicker, { ...base, value: { kind: "used", first: blankPart(), then: null }, suggestion: { kind: "used", reason: "It names a switch." }, products: screen.options.brands[0]!.products }));
    expect(html).toContain("Suggested: Used. It names a switch.");
    expect(html).toContain(">Suggested<");
    expect(html).toContain("Notes made from a template");
    expect(html).toContain("Another event from Lumen app");
    expect(html).toContain("Add a then (optional)");
    expect(html).not.toContain("An AI purpose");
  });

  it("says a product event needs the task's brand, offers operators this copy's own counts, and keeps both kinds", () => {
    const html = renderToStaticMarkup(createElement(MeasurePicker, { ...base, operator: true, value: { kind: "runs_better", first: blankPart({ kind: "runs_better" }), then: null }, suggestion: { kind: "moves", reason: "It is for the brand." }, products: null }));
    expect(html).toContain("You picked Runs better over the suggested Moves a number. Both are kept, so the suggestion can learn.");
    const used = renderToStaticMarkup(createElement(MeasurePicker, { ...base, operator: true, value: { kind: "used", first: blankPart(), then: null }, suggestion: null, products: null }));
    expect(used).toContain("A product event is counted for one brand");
    expect(used).toContain("An AI purpose of this copy");
    expect(renderToStaticMarkup(createElement(MeasurePicker, { ...base, value: blankMeasure(), suggestion: null, products: null }))).toContain("No measure. Pick a kind of win, or leave it for later.");
  });
});

describe("the list", () => {
  const row: WorkRow = {
    id: "wt_a",
    ref: 77,
    href: "/admin/work/77",
    title: "List on G2",
    status: "todo",
    statusLabel: "To do",
    tone: "neutral",
    closed: false,
    mustHave: true,
    fromVizzy: true,
    prs: ["#84"],
    stage: { n: 5, label: "Market" },
    brand: null,
    madeIdea: false,
    ideas: [],
    waitingOn: { ref: 75, title: "Credits and pricing page" },
    check: { label: "Due today", due: true, measure: false, forecast: false },
    win: "Used, then Moves a number",
  };

  it("draws a row with its chips, what it waits for and its check, and the Brand column only for more than one brand", () => {
    const multi = renderToStaticMarkup(createElement(WorkTable, { rows: [row], multiBrand: true, ideaWords: false }));
    for (const s of ["#77", "List on G2", "Must have", "From Vizzy", "#84", "Market", "Whole business", "Waiting on #75", "Due today", "Used, then Moves a number", ">Brand<", ">Launch<"]) expect(multi, s).toContain(s);
    const one = renderToStaticMarkup(createElement(WorkTable, { rows: [row], multiBrand: false, ideaWords: true }));
    expect(one).not.toContain(">Brand<");
    expect(one).toContain(">Idea<");
  });
});

describe("the import preview", () => {
  const preview: ImportPreview = {
    columns: [
      { head: "MVP", field: "mustHave" },
      { head: "Ref", field: "ref" },
      { head: "Backlog item", field: "title" },
      { head: "Status", field: "status" },
    ],
    rows: [
      { row: 2, title: "Van insurance", ref: 9, mustHave: true, description: "", notes: "Two quotes so far", status: "todo", unknownStatus: null, stage: null, brand: null, check: null, links: [], statusLabel: "To do" },
      { row: 3, title: "Workshops in store", ref: 18, mustHave: false, description: "", notes: "", status: "todo", unknownStatus: "Idea", stage: null, brand: null, check: null, links: [], statusLabel: "To do" },
    ],
    total: 2,
    refused: [{ row: 4, problem: "ref_taken", message: "Its ref is taken already." }],
    unknownStatuses: ["Idea"],
    unknownText: "1 status isn't one of Work's, so Idea comes in as To do.",
    nextRef: 19,
    refHint: "Your refs are kept. New tasks start at #19.",
  };

  it("shows each column's field, the rows, the statuses Work doesn't know, what it would refuse and what the sheet lacks", () => {
    const html = renderToStaticMarkup(createElement(PreviewView, { preview, missing: ["Stage", "Brand", "Check"], onPick: () => {}, busy: false }));
    expect(html).toContain("Field for the column Backlog item");
    expect(html).toContain("Van insurance");
    expect(html).toContain("#9");
    expect(html).toContain("Idea?");
    expect(html).toContain("1 status isn&#x27;t one of Work&#x27;s, so Idea comes in as To do.");
    expect(html).toContain("Row 4: Its ref is taken already.");
    expect(html).toContain("Your sheet has no Stage, Brand or Check, so you set those on each task after.");
    expect(html).toContain("All 2 rows.");
  });
});
