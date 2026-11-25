import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { LearnedAnswer, LearnedFact } from "@/lib/types/onboarding";
import type { ProfileKey } from "@/lib/types/businessProfile";
import { confirmBody, initialAnswers, learnedSource, removeFact, removedNote, undoRemove, unclearWords } from "./learnedReview";
import {
  BASICS_WORDS,
  DELETE_CONVERSATION_WORDS,
  FACT_WORDS,
  LEARNED_WORDS,
  TRANSCRIPT_WORDS,
  longLength,
  messageCount,
  shortDate,
  shortLength,
} from "./words";

const answers = (over: Partial<Record<ProfileKey, LearnedAnswer>> = {}): Record<ProfileKey, LearnedAnswer> => ({
  who: { value: "solo", words: "It's just me." },
  run: { value: "app", words: "a note app" },
  stage: { value: null, words: "A few friends are trying a rough version." },
  want: { value: "waitlist", words: "If a hundred people sign up" },
  ...over,
});
const FACTS: LearnedFact[] = [
  { id: "f0", kind: "goal", text: "100 sign-ups before building it", quote: "If a hundred people sign up, I'll build it properly." },
  { id: "f1", kind: "start", text: "A design prototype, no app yet", quote: "All I have is a design prototype." },
  { id: "f2", kind: "constraint", text: "Evenings only, around a day job", quote: "I've got a day job, so it's evenings." },
];

describe("Here's what I learned, as the page holds it", () => {
  it("starts from what Vizzy learned, falls back to the brand's saved answer, and leaves the rest to ask", () => {
    expect(initialAnswers(answers(), {})).toEqual({ who: "solo", run: "app", want: "waitlist" });
    expect(initialAnswers(answers(), { stage: "idea", who: "team" })).toEqual({ who: "solo", run: "app", stage: "idea", want: "waitlist" });
    expect(initialAnswers(answers({ run: { value: "robot", words: "" } }), {})).toEqual({ who: "solo", want: "waitlist" });
  });

  it("keeps the unclear words only for blanks", () => {
    expect(unclearWords(answers())).toEqual({ stage: "A few friends are trying a rough version." });
    expect(unclearWords(answers({ stage: { value: null, words: "  " } }))).toEqual({});
  });

  it("removes facts as a stack, so Undo brings back the last, and names it", () => {
    let removed = removeFact([], "f1");
    removed = removeFact(removed, "f0");
    removed = removeFact(removed, "f0");
    expect(removed).toEqual(["f1", "f0"]);
    expect(removedNote(FACTS, removed)).toBe("Removed: 100 sign-ups before building it");
    removed = undoRemove(removed);
    expect(removedNote(FACTS, removed)).toBe("Removed: A design prototype, no app yet");
    expect(removedNote(FACTS, undoRemove(removed))).toBeNull();
  });

  it("sends the answers on the page and the facts still listed, by id only", () => {
    const body = confirmBody({ who: "team", stage: "idea" }, FACTS, ["f1"]);
    expect(body).toEqual({ answers: { who: "team", stage: "idea" }, keep: ["f0", "f2"] });
    expect(JSON.stringify(body)).not.toContain("prototype");
  });

  it("names where it came from", () => {
    const now = Date.parse("2026-12-01T00:00:00Z");
    expect(learnedSource({ source: "voice", startedAt: "2026-11-25T10:00:00Z", lengthSec: 230, turnCount: 11 }, now)).toBe("From our call, 4 min, 25 Nov");
    expect(learnedSource({ source: "chat", startedAt: "2026-11-25T10:00:00Z", lengthSec: 0, turnCount: 11 }, now)).toBe("From our chat, 11 messages, 25 Nov");
    expect(shortDate("2025-11-25T10:00:00Z", now)).toBe("25 Nov 2025");
    expect(shortDate("not a date", now)).toBe("");
  });

  it("writes a call's length the mockups' way", () => {
    expect([shortLength(45), shortLength(252), shortLength(280)]).toEqual(["45 s", "4 min", "5 min"]);
    expect([longLength(45), longLength(252), longLength(240)]).toEqual(["45 s", "4 min 12 s", "4 min"]);
    expect([messageCount(1), messageCount(3)]).toEqual(["1 message", "3 messages"]);
  });

  it("uses no dashes as punctuation and none of the AI tells in any of its words", () => {
    const lines = [
      ...Object.values(LEARNED_WORDS).map((w) => (typeof w === "function" ? w("4 min", "25 Nov") : w)),
      BASICS_WORDS.change("Who you are", "A solo founder"),
      BASICS_WORDS.notSure,
      BASICS_WORDS.whyUnsure("It's just me."),
      BASICS_WORDS.notPicked,
      BASICS_WORDS.notPickedAria("Who you are"),
      FACT_WORDS.remove,
      FACT_WORDS.removeAria("No email list yet"),
      FACT_WORDS.fromCall("25 Nov"),
      FACT_WORDS.fromChat("25 Nov"),
      ...Object.values(TRANSCRIPT_WORDS).map((w) => (typeof w === "function" ? (w as (...a: unknown[]) => string)("25 Nov", "4 min 12 s", 9) : w)),
      ...Object.values(DELETE_CONVERSATION_WORDS).map((w) => (typeof w === "function" ? w("call", "25 Nov") : w)),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});
