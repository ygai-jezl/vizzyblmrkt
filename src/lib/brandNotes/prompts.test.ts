import { describe, expect, it } from "vitest";
import { BRAND_NOTE_KINDS, type BrandNoteKind } from "@/lib/types/brandNote";
import { NO_DASHES } from "@/lib/content/writingRules";
import { KIND_QUESTIONS, noteQuestion, suggestKind, suggestSubjects } from "./prompts";

const kinds = (over: Partial<Record<BrandNoteKind, number>> = {}) =>
  ({ ...Object.fromEntries(BRAND_NOTE_KINDS.map((k) => [k, 3])), ...over }) as Record<BrandNoteKind, number>;

describe("the question Add a note asks", () => {
  it("starts with the kind the brand has least of", () => {
    expect(noteQuestion(kinds({ disagree: 0 }), [], 0)).toMatchObject({ kind: "disagree", question: KIND_QUESTIONS.disagree[0] });
    expect(noteQuestion(kinds({ disagree: 0, numbers: 1 }), [], 1).kind).toBe("numbers");
  });

  it("turns between kinds and subjects nothing covers yet", () => {
    const asked = [0, 1, 2, 3].map((t) => noteQuestion(kinds({ mistake: 0 }), ["Pricing", "Share of voice"], t));
    expect(asked[0]!.kind).toBe("mistake");
    expect(asked[1]).toMatchObject({ subject: "Pricing", question: "What have you seen first-hand about Pricing?" });
    expect(asked[3]!.subject).toBe("Share of voice");
  });

  it("asks in house style: no dashes", () => {
    const all = Object.values(KIND_QUESTIONS).flat().join(" ");
    expect(all).not.toMatch(/[—–]| - /);
    expect(NO_DASHES).toBeTruthy();
  });
});

describe("what a note suggests", () => {
  it("a kind from its words", () => {
    expect(suggestKind("We ran the same prompt every day for a week.")).toBe("tested");
    expect(suggestKind("Everyone says you need daily checks. I don't believe it.")).toBe("disagree");
    expect(suggestKind("Buyers ask why they can't just check by hand.")).toBe("objection");
    expect(suggestKind("Teams forget the questions without their name in.")).toBe("mistake");
    expect(suggestKind("One customer's citations rose 40% in a quarter.")).toBe("numbers");
    expect(suggestKind("A customer found out from a prospect.")).toBe("customer_story");
  });

  it("the brand map subjects its words point at", () => {
    const subjects = [
      { id: "a", name: "Prompt monitoring" },
      { id: "b", name: "Share of voice" },
      { id: "c", name: "Citation sources" },
    ];
    expect(suggestSubjects("Teams stopped reading the results after a month.", subjects).map((s) => s.id)).toEqual([]);
    // Half a subject's words is enough to suggest it (a person decides).
    expect(suggestSubjects("We read the prompts' answers and the citation list.", subjects).map((s) => s.id)).toEqual(["a", "c"]);
    expect(suggestSubjects("Prompt monitoring daily wasted time; the citation sources told us more.", subjects).map((s) => s.id)).toEqual(["a", "c"]);
    expect(suggestSubjects("", subjects)).toEqual([]);
  });
});
