import { describe, expect, it } from "vitest";
import { blankLearned } from "../learn";
import { heardAnswers, heardLabels, notedAnswers, topicStates, validNote } from "./topics";

describe("Vizzy's silent notes during a call", () => {
  it("takes a known topic with one of its choices or unclear, and cuts their words to fit", () => {
    expect(validNote({ topic: "who", choice: "team", words: "  There are   three of us " })).toEqual({ topic: "who", choice: "team", words: "There are three of us" });
    expect(validNote({ topic: "RUN", choice: " Shop " })).toEqual({ topic: "run", choice: "shop" });
    expect(validNote({ topic: "stage", choice: "unclear", words: "" })).toEqual({ topic: "stage", choice: "unclear" });
    expect(validNote({ topic: "want", choice: "customers", words: "x".repeat(400) })!.words).toHaveLength(300);
  });

  it("refuses anything else", () => {
    for (const bad of [null, "who", 3, {}, { topic: "who" }, { topic: "age", choice: "solo" }, { topic: "who", choice: "shop" }, { topic: "who", choice: 1 }]) {
      expect(validNote(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the topics on screen", () => {
  it("starts with the first being talked about now and the rest to come", () => {
    expect(topicStates([]).map((t) => [t.label, t.state, t.answer])).toEqual([
      ["Who you are", "now", ""],
      ["What you run", "next", ""],
      ["Where it is today", "next", ""],
      ["What you want first", "next", ""],
    ]);
  });

  it("ticks a noted topic with its answer, the latest note winning, and moves now on", () => {
    const states = topicStates([
      { topic: "who", choice: "solo" },
      { topic: "run", choice: "shop" },
      { topic: "who", choice: "team" },
    ]);
    expect(states.map((t) => [t.key, t.state, t.answer])).toEqual([
      ["who", "done", "A small team"],
      ["run", "done", "A shop or products"],
      ["stage", "now", ""],
      ["want", "next", ""],
    ]);
  });

  it("leaves an unclear topic to come, and a correction to unclear unticks it", () => {
    const states = topicStates([
      { topic: "who", choice: "unclear" },
      { topic: "run", choice: "app" },
      { topic: "run", choice: "unclear" },
    ]);
    expect(states.map((t) => t.state)).toEqual(["next", "next", "now", "next"]);
    // All four noted, none now.
    const all = topicStates(["who", "run", "stage", "want"].map((topic) => ({ topic: topic as "who", choice: "unclear" })));
    expect(all.every((t) => t.state === "next")).toBe(true);
  });
});

describe("what Vizzy heard, at the end", () => {
  const notes = [
    { topic: "who" as const, choice: "team" },
    { topic: "want" as const, choice: "unclear" },
  ];

  it("is the notes until the server learned", () => {
    expect(notedAnswers(notes)).toEqual({ who: "team" });
    expect(heardAnswers(null, notes)).toEqual({ who: "team" });
  });

  it("is what the server learned once it did, even when that is less", () => {
    const learned = blankLearned("model", "2026-11-25T10:05:00.000Z");
    learned.answers.run = { value: "service", words: "a clinic" };
    learned.answers.stage = { value: "nonsense", words: "" };
    expect(heardAnswers(learned, notes)).toEqual({ run: "service" });
    expect(heardAnswers(blankLearned("m", "t"), notes)).toEqual({});
  });

  it("labels them in question order", () => {
    expect(heardLabels({ want: "audience", who: "solo" })).toEqual([
      { key: "who", label: "A solo founder" },
      { key: "want", label: "Grow an audience" },
    ]);
  });
});
