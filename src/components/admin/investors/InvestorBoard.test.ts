import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { BOARD_WORDS } from "@/lib/raise/pipeline/words";
import type { BoardAnswer, BoardCard, BoardColumn } from "./investorsApi";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { BoardView, cardLines, countsLine, MoveMenu, movedCard, moveTargets, placeCard } = await import("./InvestorBoard");

/** Every element in a tree with a given tag. */
function elementsOf(node: ReactNode, type: string, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const n of node) elementsOf(n, type, out);
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    elementsOf((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

// Made-up people at made-up firms, on a board read on 26 Nov 2026.
const TODAY = "2026-11-26";
const card = (id: string, over: Partial<BoardCard> = {}): BoardCard => ({
  id,
  name: null,
  email: null,
  firm: null,
  tier: null,
  nextStepDate: null,
  lastTouch: null,
  stageOptionId: null,
  passReason: null,
  due: [],
  quietDays: null,
  followUp: false,
  ...over,
});
const SAM = card("ct_sam", { name: "Sam Okoro", firm: "Northlight Ventures", tier: "A", nextStepDate: "2026-12-03", lastTouch: "2026-11-20", stageOptionId: "opt_contact1", quietDays: 6 });
const PRIYA = card("ct_priya", {
  name: "Priya Shah",
  firm: "Harbour Capital",
  nextStepDate: "2026-11-20",
  lastTouch: "2026-11-10",
  stageOptionId: "opt_contact1",
  due: ["quiet", "next_step"],
  quietDays: 16,
  followUp: true,
});
const ALEX = card("ct_alex", { email: "alex@example.com", stageOptionId: "opt_passed01", passReason: { optionId: "opt_crowded1", key: "crowded", label: "Crowded market" } });
const column = (optionId: string, label: string, role: BoardColumn["role"], cards: BoardCard[], count = cards.length): BoardColumn => ({
  optionId,
  label,
  preset: null,
  role,
  count,
  capped: false,
  cards,
});

function board(over: Partial<BoardAnswer> = {}): BoardAnswer {
  return {
    setUp: true,
    kinds: ["raising"],
    kind: "raising",
    tab: "Investors",
    noun: { one: "investor", many: "investors" },
    today: TODAY,
    quietAfterDays: 14,
    canMove: true,
    followUps: true,
    fields: { stage: { id: "fld_stage", label: "Stage" }, passReason: { id: "fld_reason", label: "Pass reason" } },
    reasonOptions: [
      { optionId: "opt_crowded1", label: "Crowded market", key: "crowded", area: "market" },
      { optionId: "opt_lead0001", label: "Wants a lead first", key: null, area: "other" },
    ],
    columns: [
      column("opt_research", "Research", "open", []),
      column("opt_contact1", "Contacted", "active", [PRIYA, SAM]),
      column("opt_money001", "Money in", "won", []),
      column("opt_passed01", "Passed", "passed", [ALEX]),
    ],
    totals: { people: 3, quiet: 1, nextStepPast: 1, capped: false },
    ...over,
  };
}

describe("the board's words", () => {
  it("counts investors, or lenders and funders on a Funding board", () => {
    expect(countsLine(board())).toBe("3 investors, 1 quiet for 14 days, 1 past their next step date");
    expect(countsLine({ ...board(), totals: { people: 31, quiet: 5, nextStepPast: 0, capped: false } })).toBe("31 investors, 5 quiet for 14 days");
    expect(countsLine({ ...board(), kind: "funding", totals: { people: 1, quiet: 0, nextStepPast: 0, capped: false } })).toBe("1 lender or funder, 0 quiet for 14 days");
    expect(countsLine({ ...board(), kind: "funding", totals: { people: 4, quiet: 1, nextStepPast: 2, capped: false } })).toBe(
      "4 lenders and funders, 1 quiet for 14 days, 2 past their next step date",
    );
  });

  it("say what a card holds, and a past next step date as past", () => {
    expect(cardLines(SAM, TODAY)).toEqual({
      title: "Sam Okoro",
      firm: "Northlight Ventures",
      tier: "Tier A",
      nextStep: { text: "Next step 3 Dec 2026", warn: false },
      quiet: null,
      followUp: false,
      passReason: null,
    });
    expect(cardLines(PRIYA, TODAY)).toMatchObject({ nextStep: { text: "Next step was 20 Nov 2026", warn: true }, quiet: "Quiet for 16 days", followUp: true });
    // No name: the address, as People shows them; a reason once they passed.
    expect(cardLines(ALEX, TODAY)).toMatchObject({ title: "alex@example.com", nextStep: null, passReason: "Crowded market" });
    // A past date on someone no longer in play reads as past, without the warning.
    expect(cardLines(card("ct_x", { nextStepDate: "2026-11-01", due: [] }), TODAY).nextStep).toEqual({ text: "Next step was 1 Nov 2026", warn: false });
    expect(cardLines(card("ct_y"), TODAY).title).toBe("Unnamed person");
  });

  it("keep to house style", () => {
    const texts = [countsLine(board()), ...Object.values(cardLines(PRIYA, TODAY)).filter((v): v is string => typeof v === "string")];
    for (const t of texts) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });
});

describe("moving a card", () => {
  it("offers every stage in use but its own, in the field's order", () => {
    const b = board({ columns: [...board().columns, column("archived", "No longer in use", "archived", [])] });
    expect(moveTargets(b.columns, SAM).map((c) => c.label)).toEqual(["Research", "Money in", "Passed"]);
    expect(moveTargets(b.columns, ALEX).map((c) => c.label)).toEqual(["Research", "Contacted", "Money in"]);
  });

  it("moves it at once, with the counts, its reason and what it is due worked out again", () => {
    const b = board();
    const passed = placeCard(b, movedCard(b, PRIYA, "opt_passed01", "opt_crowded1"));
    const names = (id: string) => passed.columns.find((c) => c.optionId === id)!.cards.map((c) => c.id);
    expect(names("opt_contact1")).toEqual(["ct_sam"]);
    expect(names("opt_passed01")).toEqual(["ct_priya", "ct_alex"]);
    expect(passed.columns.map((c) => c.count)).toEqual([0, 1, 0, 2]);
    const moved = passed.columns[3]!.cards[0]!;
    expect(moved).toMatchObject({ stageOptionId: "opt_passed01", passReason: { optionId: "opt_crowded1", key: "crowded", label: "Crowded market" }, due: [] });
    // Passed is no longer quiet nor past its next step.
    expect(passed.totals).toEqual({ people: 3, quiet: 0, nextStepPast: 0, capped: false });

    // Leave it blank: no reason. Leaving Passed clears it.
    expect(movedCard(b, PRIYA, "opt_passed01", null).passReason).toBeNull();
    const back = movedCard(passed, moved, "opt_research");
    expect(back).toMatchObject({ passReason: null, due: ["next_step"] });
  });

  it("puts a card by its next step date, soonest first and none last", () => {
    const b = board();
    const early = card("ct_early", { name: "Jo Park", nextStepDate: "2026-11-27", stageOptionId: "opt_contact1" });
    expect(placeCard(b, early).columns[1]!.cards.map((c) => c.id)).toEqual(["ct_priya", "ct_early", "ct_sam"]);
    const none = card("ct_none", { name: "Lee Chen", stageOptionId: "opt_contact1" });
    expect(placeCard(b, none).columns[1]!.cards.map((c) => c.id)).toEqual(["ct_priya", "ct_sam", "ct_none"]);
  });

  it("takes back an optimistic move by placing the card as it was", () => {
    const b = board();
    const moved = placeCard(b, movedCard(b, SAM, "opt_money001"));
    const undone = placeCard(moved, SAM);
    expect(undone.columns.map((c) => c.cards.map((x) => x.id))).toEqual(b.columns.map((c) => c.cards.map((x) => x.id)));
    expect(undone.columns.map((c) => c.count)).toEqual(b.columns.map((c) => c.count));
  });
});

describe("the board as drawn", () => {
  const draw = (b: BoardAnswer, onMove?: () => void) => renderToStaticMarkup(createElement(BoardView, { board: b, onMove, actions: createElement("button", null, "Paste a list (later)") }));

  it("shows the guidance, the counts, the help link, the actions slot and each stage with its count", () => {
    const html = draw(board(), () => {});
    expect(html).toContain(BOARD_WORDS.guidance);
    expect(html).toContain("3 investors, 1 quiet for 14 days, 1 past their next step date");
    expect(html).toContain(`href="${BOARD_WORDS.helpHref}"`);
    expect(html).toContain(BOARD_WORDS.howItWorks);
    expect(html).toContain("Paste a list (later)");
    for (const label of ["Research", "Contacted", "Money in", "Passed"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html.indexOf("Research")).toBeLessThan(html.indexOf("Contacted"));
    expect(html).toContain(BOARD_WORDS.emptyColumn);
    expect(html).toContain('href="/admin/crm/people/ct_priya"');
    expect(html).toContain(BOARD_WORDS.followUpChip);
    expect(html).toContain("Quiet for 16 days");
    expect(html).not.toContain(BOARD_WORDS.membersOnly);
    expect(html).not.toContain(BOARD_WORDS.emptyBoard);
  });

  it("lets admins drag a card or pick Move to, and members only read", () => {
    const admin = draw(board(), () => {});
    expect(admin).toContain('draggable="true"');
    expect(admin).toContain(`aria-label="${BOARD_WORDS.moveTo}: Sam Okoro"`);
    // A menu of buttons, never a select an arrow key could pick from.
    expect(admin).not.toContain("<select");
    expect(admin).toContain("<details");
    const member = draw(board({ canMove: false }), () => {});
    expect(member).toContain(BOARD_WORDS.membersOnly);
    expect(member).not.toContain('draggable="true"');
    expect(member).not.toContain(BOARD_WORDS.moveTo);
  });

  it("moves a card only when a stage's button is pressed, never by opening or moving through the menu", () => {
    const onMove = vi.fn();
    const targets = moveTargets(board().columns, SAM);
    const menu = MoveMenu({ card: SAM, title: "Sam Okoro", targets, onMove });
    expect(menu.type).toBe("details");
    expect(elementsOf(menu, "select")).toEqual([]);
    const [summary] = elementsOf(menu, "summary");
    expect(Object.keys(summary!.props as object).filter((k) => k.startsWith("on"))).toEqual([]);
    const buttons = elementsOf(menu, "button");
    expect(buttons.map((b) => (b.props as { children: string }).children)).toEqual(["Research", "Money in", "Passed"]);
    expect(buttons.every((b) => (b.props as { type: string }).type === "button")).toBe(true);
    expect(onMove).not.toHaveBeenCalled();
    const closed: string[] = [];
    (buttons[1]!.props as { onClick: (e: unknown) => void }).onClick({ currentTarget: { closest: () => ({ removeAttribute: (a: string) => closed.push(a) }) } });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(SAM, "opt_money001");
    expect(closed).toEqual(["open"]);
  });

  it("says when the board is empty, a stage is capped, or stages no longer in use still hold people", () => {
    const empty = board({ columns: [column("opt_research", "Research", "open", [])], totals: { people: 0, quiet: 0, nextStepPast: 0, capped: false } });
    expect(draw(empty)).toContain(BOARD_WORDS.emptyBoard);
    const capped = board({ totals: { ...board().totals, capped: true } });
    expect(draw(capped)).toContain(BOARD_WORDS.capped);
    const archived = board({ columns: [...board().columns, column("archived", BOARD_WORDS.archivedColumn, "archived", [card("ct_old", { name: "Kim Lee", stageOptionId: "opt_meeting1" })])] });
    expect(draw(archived, () => {})).toContain(`aria-label="${BOARD_WORDS.archivedColumn}"`);
  });
});
