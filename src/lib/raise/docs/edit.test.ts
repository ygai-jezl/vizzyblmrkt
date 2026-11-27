import { describe, expect, it } from "vitest";
import {
  addSlide,
  blockBody,
  dismissNeed,
  editSegments,
  insertBlock,
  isChanged,
  isPending,
  moveSlide,
  needsCount,
  pendingServerBlock,
  removeBlock,
  removeSlide,
  saveBody,
  showsUkReminder,
  typedLocalBlock,
  withSegmentText,
} from "./edit";
import { block, slide } from "./testing/fixtures";
import { BLOCK_ID, NEED_ID, SLIDE_ID } from "./types";

describe("numbers inserted in the studio", () => {
  it("ask the server for YouGrow's own numbers, filled on save", () => {
    const b = pendingServerBlock({ meaning: "waitlistSignups", grain: "week", weeks: 8 });
    expect(b).toMatchObject({ meaning: "waitlistSignups", grain: "week", weeks: 8, value: null, display: "", name: "Sign-ups a week", source: { kind: "insights" } });
    expect(b.id).toMatch(BLOCK_ID);
    expect(isPending(b)).toBe(true);
    expect(pendingServerBlock({ meaning: "signupGrowth", grain: "week" })).toMatchObject({ grain: "total", unit: "percent", weeks: 12 });
    const launch = pendingServerBlock({ meaning: "launchSignups", grain: "total", launchId: "c1", launchName: "Spring box" });
    expect(launch).toMatchObject({ launchId: "c1", name: "People on Spring box", source: { kind: "audience" } });
    expect(launch.weeks).toBeUndefined();
  });

  it("show a typed number at once in the slide's own format", () => {
    const b = typedLocalBlock({ name: " Monthly  sales ", value: 14200, unit: "money", currency: "GBP", per: "month", from: "your till" });
    expect(b).toMatchObject({ meaning: "typed", name: "Monthly sales", display: "£14,200 a month", source: { kind: "typed", from: "your till" }, grain: "total" });
    const series = typedLocalBlock({ name: "Sales", value: 3, unit: "count", series: [{ label: "Jan", value: 1 }, { label: "Feb", value: 3 }] });
    expect(series.grain).toBe("month");
    expect(series.series).toHaveLength(2);
  });

  it("go in the field the person was in, or need no token where the layout shows numbers", () => {
    const b = block({ id: "mb_new00001" });
    const s = slide({ headline: "People want it", layout: "statement" });
    expect(insertBlock(s, b)!.headline).toBe("People want it {{mb_new00001}}");
    expect(insertBlock(s, b, { kind: "notes" })!.notes).toBe("{{mb_new00001}}");
    expect(insertBlock({ ...s, points: ["One"] }, b, { kind: "point", i: 0 })!.points).toEqual(["One {{mb_new00001}}"]);
    expect(insertBlock({ ...s, layout: "big_number" }, b)!.headline).toBe("People want it");
    const full = { ...s, blocks: [block({ id: "mb_a0000001" }), block({ id: "mb_a0000002" }), block({ id: "mb_a0000003" })] };
    expect(insertBlock(full, b)).toBeNull();
  });

  it("take their tokens with them when removed", () => {
    const s = slide({ headline: "{{mb_aaaaaaaa}} joined in {{mb_aaaaaaaa:period}}", notes: "Say {{mb_aaaaaaaa}} slowly", blocks: [block()] });
    const out = removeBlock(s, "mb_aaaaaaaa");
    expect(out.blocks).toEqual([]);
    expect(out.headline).toBe("joined in");
    expect(out.notes).toBe("Say slowly");
  });
});

describe("text with numbers in it", () => {
  it("always leaves a place to type before, between and after each number", () => {
    expect(editSegments("{{mb_aaaaaaaa}}{{mb_bbbbbbbb}}").map((s) => s.kind)).toEqual(["text", "block", "text", "block", "text"]);
    expect(editSegments("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(withSegmentText("{{mb_aaaaaaaa}} joined", 0, "Over ")).toBe("Over {{mb_aaaaaaaa}} joined");
    expect(withSegmentText("{{mb_aaaaaaaa}} joined", 1, "ignored")).toBe("{{mb_aaaaaaaa}} joined");
  });
});

describe("slides", () => {
  const three = [slide(), slide(), slide()];

  it("add a section after the one in view, with a Needs until it says its point", () => {
    const out = addSlide(three, 0, "why_now")!;
    expect(out.index).toBe(1);
    expect(out.slides[1]).toMatchObject({ section: "why_now", layout: "statement", headline: "Why now" });
    expect(out.slides[1]!.id).toMatch(SLIDE_ID);
    expect(out.slides[1]!.needs[0]!.id).toMatch(NEED_ID);
    expect(addSlide(Array.from({ length: 16 }, () => slide()), 0, "team")).toBeNull();
  });

  it("move within the deck and keep at least 3", () => {
    expect(moveSlide(three, 0, 1).map((s) => s.id)).toEqual([three[1]!.id, three[0]!.id, three[2]!.id]);
    expect(moveSlide(three, 0, -1).map((s) => s.id)).toEqual(three.map((s) => s.id));
    expect(removeSlide(three, 1)).toBeNull();
    expect(removeSlide([...three, slide()], 1)).toHaveLength(3);
  });

  it("drop a Needs callout when dismissed", () => {
    const s = slide({ needs: [{ id: "nd_aaaaaaaa", text: "team bios" }] });
    expect(dismissNeed(s, "nd_aaaaaaaa").needs).toEqual([]);
    expect(needsCount([s, slide()])).toBe(1);
  });
});

describe("the save", () => {
  it("sends YouGrow's numbers by what they ask for and typed ones with their figure, never Vizzy's originals", () => {
    const typed = block({ id: "mb_typed001", meaning: "typed", name: "Monthly sales", value: 14200, unit: "money", currency: "GBP", per: "month", source: { kind: "typed", from: "your till", typedBy: "usr_admin" } });
    const s = slide({ blocks: [block(), typed], ai: { headline: "x", points: [], notes: "", at: "2026-11-26T10:00:00.000Z", prompt: "raise.deck_draft@1" } });
    const body = saveBody(3, "  Acme pre-seed ", [s, slide(), slide()], " Tightened the ask ");
    expect(body.baseVersion).toBe(3);
    expect(body.title).toBe("Acme pre-seed");
    expect(body.note).toBe("Tightened the ask");
    expect("ai" in body.slides[0]!).toBe(false);
    expect(body.slides[0]!.blocks).toEqual([
      { id: "mb_aaaaaaaa", meaning: "waitlistSignups", grain: "total", weeks: 12 },
      { id: "mb_typed001", meaning: "typed", grain: "total", name: "Monthly sales", value: 14200, unit: "money", currency: "GBP", per: "month", from: "your till" },
    ]);
    expect(saveBody(1, " ", [slide()]).title).toBe("Deck");
    expect(saveBody(1, "A", [slide()], "  ").note).toBeUndefined();
    expect(blockBody(block({ meaning: "typed", value: null }))).toBeNull();
  });

  it("knows when the deck has changed", () => {
    const slides = [slide()];
    expect(isChanged({ title: "A", slides }, { title: "A", slides: [...slides] })).toBe(false);
    expect(isChanged({ title: "A", slides }, { title: "B", slides })).toBe(true);
    expect(isChanged({ title: "A", slides }, { title: "A", slides: [{ ...slides[0]!, headline: "New" }] })).toBe(true);
  });

  it("shows the UK reminder before Save as PDF for investor decks only", () => {
    expect(showsUkReminder("investor")).toBe(true);
    expect(showsUkReminder("lender")).toBe(false);
  });
});
