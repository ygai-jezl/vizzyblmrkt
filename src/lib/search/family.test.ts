import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOKS_LIKE } from "@/lib/brandMap/embed";
import { NEAR_SUBJECT } from "@/lib/connectors/signals/detect";
import { articleIdOfRef, competitorArticleRef, cutOff, noteIdOfQuestionRef, noteQuestionRef, noteSearchSources } from "./family";
import { isSearchFamilyIndexEnabled, isSearchNoteReadsEnabled, isSearchSubjectReadsEnabled } from "./flags";

// The brand map family's refs, cut-offs and switches (ADR-0023).
afterEach(() => vi.unstubAllEnvs());

describe("refs", () => {
  it("names an open question by its note, and a competitor article by its competitor and id", () => {
    expect(noteQuestionRef("bn_1")).toBe("note_bn_1");
    expect(noteIdOfQuestionRef("note_bn_1")).toBe("bn_1");
    expect(noteIdOfQuestionRef("q_1")).toBeNull();
    expect(noteIdOfQuestionRef("note_")).toBeNull();
    expect(competitorArticleRef("cmp_1", "cmp_1_abc")).toBe("cmp_1/cmp_1_abc");
    expect(articleIdOfRef("cmp_1/cmp_1_abc")).toBe("cmp_1_abc");
    expect(articleIdOfRef("cmp_1")).toBeNull();
    expect(articleIdOfRef("cmp_1/")).toBeNull();
  });
});

describe("notes in the family", () => {
  const n = (over: Record<string, unknown> = {}) => ({ id: "bn_1", text: "We repot in spring.", status: "kept", canName: false, source: "typed", ...over }) as never;

  it("keeps a kept note, an asked question, and an answered one as both, each with its status", () => {
    expect(noteSearchSources(n())).toEqual([{ kind: "note", ref: "bn_1", title: "We repot in spring.", body: "We repot in spring.", url: "/admin/brand-kit/notes", status: "kept" }]);
    expect(noteSearchSources(n({ status: "asked", text: "", source: "question", question: "When do you repot?" }))).toEqual([
      { kind: "question", ref: "note_bn_1", title: "When do you repot?", body: "When do you repot?", url: "/admin/brand-kit/notes", status: "asked" },
    ]);
    const answered = noteSearchSources(n({ source: "question", question: "When do you repot?" }));
    expect(answered.map((x) => `${x.kind}:${x.ref}:${x.status}`)).toEqual(["note:bn_1:kept", "question:note_bn_1:answered"]);
    expect(answered[0]!.body).toBe("Asked: When do you repot?\n\nWe repot in spring.");
    // Asked and answered, the question's text is the same: only its status moves.
    expect(answered[1]!.body).toBe("When do you repot?");
  });

  it("keeps nothing of a note that may name a customer, or one only suggested", () => {
    expect(noteSearchSources(n({ canName: true }))).toEqual([]);
    expect(noteSearchSources(n({ canName: true, source: "question", question: "When do you repot?" }))).toEqual([]);
    expect(noteSearchSources(n({ status: "suggested" }))).toEqual([]);
  });
});

describe("cut-offs", () => {
  it("are pairs, one for each store, picked by whether the reader uses brand search", () => {
    expect(cutOff({ old: 0.9, new: 0.8 }, false)).toBe(0.9);
    expect(cutOff({ old: 0.9, new: 0.8 }, true)).toBe(0.8);
    for (const pair of [LOOKS_LIKE, NEAR_SUBJECT]) expect(Object.keys(pair).sort()).toEqual(["new", "old"]);
    expect(LOOKS_LIKE.old).toBe(0.9);
    expect(NEAR_SUBJECT.old).toBe(0.6);
  });
});

describe("switches", () => {
  it("need what they say they need: the family the index, the subject reads the family", () => {
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "true");
    expect(isSearchFamilyIndexEnabled()).toBe(false);
    expect(isSearchSubjectReadsEnabled()).toBe(false);
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    expect(isSearchFamilyIndexEnabled()).toBe(true);
    expect(isSearchSubjectReadsEnabled()).toBe(true);
    vi.stubEnv("SEARCH_NOTE_READS_ENABLED", "true");
    expect(isSearchNoteReadsEnabled()).toBe(true);
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    expect(isSearchSubjectReadsEnabled()).toBe(false);
    expect(isSearchNoteReadsEnabled()).toBe(false);
  });
});
