import { describe, expect, it } from "vitest";
import { MIN_SLIDE_SECONDS, deckTarget, isOver, presentAction, slideTargets, stepTo, timerLines } from "./present";

describe("Present", () => {
  it("maps the keys: arrows, Space and Page Down move on, Page Up back, N notes, T the timer, Escape leaves", () => {
    for (const key of ["ArrowRight", " ", "PageDown"]) expect(presentAction(key)).toBe("next");
    for (const key of ["ArrowLeft", "PageUp"]) expect(presentAction(key)).toBe("back");
    expect(presentAction("n")).toBe("notes");
    expect(presentAction("N")).toBe("notes");
    expect(presentAction("t")).toBe("timer");
    expect(presentAction("Escape")).toBe("leave");
    expect(presentAction("Home")).toBe("first");
    expect(presentAction("End")).toBe("last");
    expect(presentAction("x")).toBeNull();
  });

  it("stays inside the deck", () => {
    expect(stepTo(0, 10, "back")).toBe(0);
    expect(stepTo(0, 10, "next")).toBe(1);
    expect(stepTo(9, 10, "next")).toBe(9);
    expect(stepTo(5, 10, "first")).toBe(0);
    expect(stepTo(5, 10, "last")).toBe(9);
    expect(stepTo(0, 0, "next")).toBe(0);
  });

  it("gives each slide its notes' time as a target, with a short floor, and the deck their sum", () => {
    const targets = slideTargets([40, 0, 12.4]);
    expect(targets).toEqual([40, MIN_SLIDE_SECONDS, MIN_SLIDE_SECONDS]);
    expect(deckTarget(targets)).toBe(70);
  });

  it("turns the slide's time amber once it is over its target", () => {
    expect(isOver(31, 30)).toBe(true);
    expect(isOver(30, 30)).toBe(false);
    expect(isOver(10, 0)).toBe(false);
    expect(timerLines({ slideElapsed: 42, slideTarget: 30, totalElapsed: 190, totalTarget: 240 })).toEqual({
      slide: "This slide 0:42 of about 0:30",
      total: "Total 3:10 of about 4:00",
      over: true,
    });
  });
});
