import { describe, expect, it } from "vitest";
import { ONBOARDING_LIMITS, VoiceTurnSchema } from "@/lib/types/onboarding";
import { EMPTY_TRANSCRIPT, addPiece, cameBySoftNavigation, cleanText, clock, finishLine, leftBySoftNavigation, nextUpload, turnsForUpload } from "./transcript";

describe("a call's transcript in the browser", () => {
  it("joins pieces from the same speaker, and a new speaker finishes the line", () => {
    let t = addPiece(EMPTY_TRANSCRIPT, "vizzy", "Hi! Tell me", 0);
    t = addPiece(t, "vizzy", " about your shop.", 1);
    expect(t).toEqual({ lines: [], partial: { who: "vizzy", text: "Hi! Tell me about your shop.", atSec: 0 } });
    t = addPiece(t, "member", " We sell plants", 4);
    t = addPiece(t, "member", " online.", 5);
    expect(t.lines).toEqual([{ who: "vizzy", text: "Hi! Tell me about your shop.", atSec: 0 }]);
    expect(t.partial).toEqual({ who: "member", text: "We sell plants online.", atSec: 4 });
    t = finishLine(t);
    expect(t.lines).toHaveLength(2);
    expect(t.partial).toBeNull();
    expect(finishLine(t)).toBe(t);
  });

  it("drops a line with no words, and ignores an empty piece", () => {
    const t = addPiece(EMPTY_TRANSCRIPT, "member", " ", 2);
    expect(finishLine(t).lines).toEqual([]);
    expect(addPiece(t, "member", "", 3)).toBe(t);
  });

  it("cleans words the way the server keeps them", () => {
    expect(cleanText("  We\tsell\n\nplants\u0007 ")).toBe("We sell plants");
  });

  it("uploads every finished line as turns the server takes, splitting a long one", () => {
    const long = `${"word ".repeat(500)}end`;
    const turns = turnsForUpload([
      { who: "vizzy", text: "Hi!", atSec: 0 },
      { who: "member", text: long, atSec: 3.7 },
      { who: "member", text: "  ", atSec: 9 },
    ]);
    expect(turns[0]).toEqual({ who: "vizzy", text: "Hi!", atSec: 0 });
    expect(turns.length).toBe(3);
    expect(turns.slice(1).map((t) => t.text).join(" ")).toBe(cleanText(long));
    for (const turn of turns) {
      expect(VoiceTurnSchema.safeParse(turn).success).toBe(true);
      expect(turn.text.length).toBeLessThanOrEqual(ONBOARDING_LIMITS.MAX_TURN_TEXT);
    }
    expect(turns[1]!.atSec).toBe(3);
  });

  it("uploads at most 20 turns from the offset and the newest 8 notes", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ who: "member" as const, text: `Line ${i}`, atSec: i }));
    const notes = Array.from({ length: 10 }, (_, i) => ({ topic: "who" as const, choice: i % 2 ? "solo" : "team" }));
    const up = nextUpload(turns, 5, notes);
    expect(up.from).toBe(5);
    expect(up.turns.map((t) => t.text)).toEqual(turns.slice(5, 25).map((t) => t.text));
    expect(up.notes).toEqual(notes.slice(2));
    expect(nextUpload(turns, 30, []).turns).toEqual([]);
  });

  it("keeps an upload under the server's body limit, even in a script with wide characters", () => {
    const wide = "植物".repeat(1000);
    const turns = Array.from({ length: 20 }, (_, i) => ({ who: "member" as const, text: wide, atSec: i }));
    const up = nextUpload(turns, 0, []);
    expect(up.turns.length).toBeGreaterThan(0);
    expect(up.turns.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify({ ...up, reason: "closed" })).length).toBeLessThanOrEqual(ONBOARDING_LIMITS.MAX_BODY_BYTES);
  });

  it("shows time as minutes and seconds", () => {
    expect(clock(300)).toBe("5:00");
    expect(clock(168)).toBe("2:48");
    expect(clock(9.9)).toBe("0:09");
    expect(clock(-3)).toBe("0:00");
  });
});

describe("arriving at the welcome", () => {
  it("is a soft arrival when the document is another page's", () => {
    expect(cameBySoftNavigation("https://app.example.com/admin", "/admin/welcome")).toBe(true);
    expect(cameBySoftNavigation("https://app.example.com/admin/welcome/questions", "/admin/welcome")).toBe(true);
  });

  it("is not when the document is the welcome's own, with or without a slash or a query", () => {
    expect(cameBySoftNavigation("https://app.example.com/admin/welcome", "/admin/welcome")).toBe(false);
    expect(cameBySoftNavigation("https://app.example.com/admin/welcome/?again=1", "/admin/welcome")).toBe(false);
  });

  it("can't tell without a navigation entry, so it doesn't load again", () => {
    expect(cameBySoftNavigation(undefined, "/admin/welcome")).toBe(false);
    expect(cameBySoftNavigation("not a url", "/admin/welcome")).toBe(false);
  });
});

describe("leaving the welcome", () => {
  const WELCOME = "https://app.example.com/admin/welcome";

  it("is a soft exit when the welcome's own document now shows another page", () => {
    for (const shown of ["/admin", "/admin/welcome/questions", "/admin/welcome/learned", "/admin/people"]) {
      expect(leftBySoftNavigation(WELCOME, shown, "/admin/welcome"), shown).toBe(true);
    }
    expect(leftBySoftNavigation(`${WELCOME}/?c=1`, "/admin", "/admin/welcome")).toBe(true);
  });

  it("is not while the welcome is shown, nor in any other page's document", () => {
    expect(leftBySoftNavigation(WELCOME, "/admin/welcome", "/admin/welcome")).toBe(false);
    expect(leftBySoftNavigation(WELCOME, "/admin/welcome/", "/admin/welcome")).toBe(false);
    expect(leftBySoftNavigation("https://app.example.com/admin", "/admin/people", "/admin/welcome")).toBe(false);
    expect(leftBySoftNavigation("https://app.example.com/admin/welcome/questions", "/admin", "/admin/welcome")).toBe(false);
  });

  it("can't tell without a navigation entry or a path, so it doesn't load again", () => {
    expect(leftBySoftNavigation(undefined, "/admin", "/admin/welcome")).toBe(false);
    expect(leftBySoftNavigation("not a url", "/admin", "/admin/welcome")).toBe(false);
    expect(leftBySoftNavigation(WELCOME, null, "/admin/welcome")).toBe(false);
  });
});
