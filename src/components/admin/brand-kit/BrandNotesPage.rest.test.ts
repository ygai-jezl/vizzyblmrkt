import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrandNote, NoteUse } from "@/lib/types/brandNote";
import { BrandNotesPage } from "./BrandNotesPage";

const NOW = "2026-10-29T12:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const note = (id: string, text: string, uses: NoteUse[], usedBy = uses.filter((u) => u.written).map((u) => u.ref)): BrandNote => ({
  id,
  tenantId: "ten_A",
  text,
  kind: "customer_story",
  subjectIds: [],
  canName: false,
  source: "typed",
  sourceRef: null,
  status: "kept",
  usedBy,
  uses,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
});
const NOTES: BrandNote[] = [
  note("bn_recent00001", "A rival's page went offline and a client's share jumped.", [
    { ref: "ws_1/p_2", title: "Prompt tracking for agencies", at: daysAgo(6), written: true },
    { ref: "ws_1/p_1", title: "Share of voice: what moves it", at: daysAgo(47), written: true },
  ]),
  note("bn_usedup00001", "Daily swings were mostly noise.", [{ ref: "ws_1/p_3", title: "Daily or weekly", at: daysAgo(90), written: true }], ["ws_1/p_8", "ws_1/p_9", "ws_1/p_3"]),
  note("bn_held0000001", "Local shops say AI answers don't matter to them.", [{ ref: "ws_1/p_4", title: "Share of voice for local shops", at: daysAgo(2), written: false }]),
  note("bn_ready000001", "Teams that track every prompt act on a handful.", [{ ref: "ws_1/p_5", title: "Tracking", at: daysAgo(52), written: true }]),
  note("bn_fresh000001", "Nobody reads a monitoring report that has no next step.", []),
];
const html = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(BrandNotesPage, {
      initialNotes: NOTES,
      subjects: null,
      canEdit: true,
      questionsOn: true,
      rest: { settings: { restDays: 30, maxUses: 3 }, now: NOW },
      ...over,
    }),
  );

describe("Brand › What we've seen with notes resting after use", () => {
  it("says on each note how often and when it was used, and whether it rests", () => {
    const out = html();
    expect(out).toContain("Resting until 22 Nov");
    expect(out).toContain("used in 2 articles · last on 23 Oct");
    expect(out).toContain(">Used up<");
    expect(out).toContain("Goes in only when someone adds it to an article.");
    expect(out).toContain(">In a draft<");
    expect(out).toContain("In the draft “Share of voice for local shops”, not written yet.");
    expect(out).toContain("used in 1 article · last on 7 Sept");
    expect(out).toContain("not used yet");
    expect(out.match(/Where it was used · Show/g)).toHaveLength(4);
  });

  it("counts and filters the notes ready, resting and used up", () => {
    const out = html();
    expect(out).toContain("Ready · 2");
    expect(out).toContain("Resting · 2");
    expect(out).toContain("Used up · 1");
    expect(out).toMatch(/Ready for an article<\/span><span[^>]*>2</);
  });

  it("lets an admin set how long a note rests, and tells a member what it is", () => {
    const admin = html();
    expect(admin).toContain("How often a note goes in");
    expect(admin).toMatch(/<input[^>]*value="30"/);
    expect(admin).toMatch(/<input[^>]*value="3"/);
    expect(admin).toContain("Every article also asks your team three new questions");
    const member = html({ canEdit: false });
    expect(member).toContain("A note rests for 30 days after an article uses it. After 3 articles, it goes in only when someone adds it.");
    expect(member).not.toMatch(/<input[^>]*value="30"/);
  });

  it("shows none of it with the switch off", () => {
    const out = html({ rest: null });
    expect(out).not.toContain("How often a note goes in");
    expect(out).not.toContain("Resting");
    expect(out).not.toContain("Where it was used");
    expect(out).toContain("used in 2 articles");
    expect(out).not.toContain("last on");
  });
});
