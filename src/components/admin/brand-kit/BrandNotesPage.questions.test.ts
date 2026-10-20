import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrandNote } from "@/lib/types/brandNote";
import { BrandNotesPage } from "./BrandNotesPage";

const base: Pick<BrandNote, "tenantId" | "canName" | "sourceRef" | "subjectIds" | "createdBy" | "createdAt" | "updatedAt"> = {
  tenantId: "ten_A",
  canName: false,
  sourceRef: null,
  subjectIds: [],
  createdBy: null,
  createdAt: "",
  updatedAt: "",
};
const NOTES: BrandNote[] = [
  {
    ...base,
    usedBy: ["ws_1/plan_1"],
    id: "bn_answered0001",
    text: "Daily checks took an hour we never got back.",
    kind: "tested",
    status: "kept",
    source: "question",
    question: "What did daily checks cost you?",
    askedFor: [{ ref: "ws_1/plan_1", title: "How often to check" }],
  },
  {
    ...base,
    usedBy: [],
    id: "bn_open00000001",
    text: "",
    kind: "tested",
    status: "asked",
    source: "question",
    question: "When did a weekly check miss a change?",
    askedFor: [{ ref: "ws_1/plan_1", title: "How often to check" }],
  },
];
const html = (questionsOn: boolean) =>
  renderToStaticMarkup(createElement(BrandNotesPage, { initialNotes: NOTES, subjects: null, canEdit: true, questionsOn }));

describe("Brand › What we've seen with open questions", () => {
  it("lists open questions apart, counted, and shows an answered one with its question and article", () => {
    const out = html(true);
    expect(out).toContain("Open questions · 1");
    expect(out).toContain("asked by your articles, not answered yet");
    expect(out).toContain("Open questions don’t count here until they’re answered.");
    // All shows notes only: the open question waits under its own filter.
    expect(out).not.toContain("When did a weekly check miss a change?");
    expect(out).toContain("Asked: What did daily checks cost you?");
    expect(out).toContain('href="/admin/workspace/ws_1/create/plan_1"');
    expect(out).toContain("Answer to a question");
    // The header counts notes, not questions.
    expect(out).toMatch(/Your notes <span[^>]*>1<\/span>/);
  });

  it("shows none of it with the switch off", () => {
    const out = html(false);
    expect(out).not.toContain("Open questions");
  });
});
