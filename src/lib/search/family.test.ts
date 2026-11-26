import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOKS_LIKE } from "@/lib/brandMap/embed";
import { NEAR_SUBJECT } from "@/lib/connectors/signals/detect";
import { articleIdOfRef, competitorArticleRef, cutOff, noteIdOfQuestionRef, noteQuestionRef } from "./family";
import { isSearchFamilyIndexEnabled, isSearchSubjectReadsEnabled } from "./flags";

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
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    expect(isSearchSubjectReadsEnabled()).toBe(false);
  });
});
