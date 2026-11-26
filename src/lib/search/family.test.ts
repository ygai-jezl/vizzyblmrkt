import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOKS_LIKE } from "@/lib/brandMap/embed";
import { NEAR_SUBJECT } from "@/lib/connectors/signals/detect";
import { COVERED_SIM as PACK_COVERED_SIM } from "@/lib/brandContext/pack";
import { CANDIDATE_MIN_SIM, DUP_NOTE_SIM, DUP_QUESTION_SIM } from "@/lib/content/blog/seen";
import { MIN_SIM } from "@/lib/competitors/planning";
import { COVERED_SIM } from "@/lib/competitors/planningApi";
import { articleIdOfRef, competitorArticleRef, competitorArticleSource, cutOff, noteIdOfQuestionRef, noteQuestionRef, noteSearchSources } from "./family";
import { isSearchCompetitorReadsEnabled, isSearchFamilyIndexEnabled, isSearchNoteReadsEnabled, isSearchSubjectReadsEnabled } from "./flags";

// The brand map family's refs, cut-offs and switches (ADR-0025).
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

describe("competitor articles in the family", () => {
  it("are kept with their competitor's name, and only with the family", () => {
    const c = { id: "cmp_1", name: "Leafy" };
    const a = { id: "cmp_1_a", title: "Repot guide", summary: "How to repot.", question: "When to repot?", angle: "Seasons" };
    expect(competitorArticleSource(c, a, { family: true })).toEqual({
      kind: "competitor",
      ref: "cmp_1/cmp_1_a",
      title: "Leafy: Repot guide",
      body: "How to repot.\n\nAnswers: When to repot?\n\nAngle: Seasons",
      url: "/admin/brand-kit/competitors/cmp_1",
      status: "kept",
    });
    expect(competitorArticleSource(c, a)).not.toHaveProperty("status");
    expect(competitorArticleSource(c, { ...a, summary: "", question: "", angle: "" })).toBeNull();
  });
});

describe("cut-offs", () => {
  it("are pairs, one for each store, picked by whether the reader uses brand search", () => {
    expect(cutOff({ old: 0.9, new: 0.8 }, false)).toBe(0.9);
    expect(cutOff({ old: 0.9, new: 0.8 }, true)).toBe(0.8);
    for (const pair of [LOOKS_LIKE, NEAR_SUBJECT, CANDIDATE_MIN_SIM, DUP_QUESTION_SIM, DUP_NOTE_SIM, MIN_SIM, COVERED_SIM, PACK_COVERED_SIM]) expect(Object.keys(pair).sort()).toEqual(["new", "old"]);
    // The old store's values stay as they were measured.
    expect([CANDIDATE_MIN_SIM.old, DUP_QUESTION_SIM.old, DUP_NOTE_SIM.old, MIN_SIM.old, COVERED_SIM.old, PACK_COVERED_SIM.old]).toEqual([0.5, 0.93, 0.85, 0.65, 0.65, 0.65]);
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
    vi.stubEnv("SEARCH_COMPETITOR_READS_ENABLED", "true");
    expect(isSearchCompetitorReadsEnabled()).toBe(true);
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    expect(isSearchSubjectReadsEnabled()).toBe(false);
    expect(isSearchNoteReadsEnabled()).toBe(false);
    expect(isSearchCompetitorReadsEnabled()).toBe(false);
  });
});
