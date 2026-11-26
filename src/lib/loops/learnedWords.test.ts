import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import * as W from "./learnedWords";
import { BRAND_SCOPE } from "./read";
import { BY_LEARNER, LOOP_RULES } from "./registry";
import { verdict } from "./verdict";
import { lookReadOf, verdictWords } from "./verdictWords";
import type { LookRead } from "@/lib/types/loopDay";

/**
 * The words of step 4's screens (the plan for steps 4 and 5, section 6), checked against the
 * canvas's own lines for Hearth Bakery and Lumen, and every line against the writing rules.
 */

const NATURAL = "image_style.natural_photo";
const LINES: string[] = [];
const say = (s: string | null) => {
  if (s) LINES.push(s);
  return s;
};

const outputs = (hits: number, n: number): boolean[] => Array.from({ length: n }, (_, i) => i < hits);
function readOf(check: [number, number, number, number], guard: [number, number, number, number] = [4, 40, 4, 40], before = check[1]): LookRead {
  const v = verdict({
    line: BY_LEARNER.votes,
    check: { before: outputs(check[0], check[1]), after: outputs(check[2], check[3]) },
    guard: { before: outputs(guard[0], guard[1]), after: outputs(guard[2], guard[3]) },
    prior: { check: 0.5, guard: 0.25 },
    startsAt: LOOP_RULES.warmUp,
  });
  return lookReadOf(v, { usableBefore: before, after: check[3], at: "2027-05-03T09:00:00.000Z" });
}

describe("the What it learned card's words", () => {
  it("names a style and the brand's look, with the brand scope read.ts uses", () => {
    expect(W.BRAND_LOOK_SCOPE).toBe(BRAND_SCOPE);
    expect(W.lookName(NATURAL)).toBe("Natural photo");
    expect(W.lookName(BRAND_SCOPE)).toBe("Your brand's look");
  });

  it("says where a look came from, with the top thumbs down reason", () => {
    expect(say(W.fromLine({ liked: 3, disliked: 2, newestAt: "2027-01-14T09:00:00.000Z", downReasons: { mood: 2 } }))).toBe(
      "From 3 images you liked and 2 you didn't (Wrong mood or style 2), newest 14 Jan",
    );
    expect(say(W.fromLine({ liked: 4, disliked: 0, uploaded: 4, newestAt: "2026-12-02T09:00:00.000Z" }))).toBe("From 4 photos you uploaded, newest 2 Dec");
    expect(say(W.fromLine({ liked: 20, disliked: 8, newestAt: "2027-01-17T09:00:00.000Z", downReasons: { fake: 3, colours: 1 } }))).toBe(
      "From 20 images you liked and 8 you didn't (Looks fake 3), newest 17 Jan",
    );
    expect(W.fromLine(null)).toBeNull();
    expect(say(W.restoredFromLine(2, { liked: 18, disliked: 7, newestAt: "2026-12-08T09:00:00.000Z" }, false))).toBe("Version 2's look came from 18 images you liked and 7 you didn't, newest 8 Dec");
    expect(say(W.restoredFromLine(1, null, true))).toBe("Version 1's look was carried over from before YouGrow kept versions");
  });

  it("counts, waits and holds in the canvas's words", () => {
    expect(say(W.countsLine({ made: 0, voted: 0, liked: 0 }))).toBe("Made 0 with it so far.");
    expect(say(W.countsLine({ made: 56, voted: 14, liked: 9 }))).toBe("Made 56 with it. You liked 9 of the 14 you voted on.");
    expect(say(W.pendingLine({ brand: false, have: 1, brandLook: true }))).toBe("1 of the 3 likes it needs. Uses your brand's look meanwhile.");
    expect(say(W.pendingLine({ brand: true, have: 0, brandLook: false }))).toBe("0 of the 3 likes or uploads it needs.");
    expect(say(W.usedForLine(["Product still life"]))).toBe("Used for Product still life until it learns its own.");
    expect(say(W.holdLine({ counted: 9, adoptedAt: "2027-01-14T09:00:00.000Z", now: new Date("2027-05-12T09:00:00.000Z") }))).toBe(
      "Keeping this look for 1 more vote, so YouGrow can check the next change against it. About May at your pace.",
    );
    expect(say(W.holdLine({ counted: 0, adoptedAt: "2027-01-14T09:00:00.000Z", now: new Date("2027-05-12T09:00:00.000Z") }))).toBe(
      "Keeping this look for 10 more votes, so YouGrow can check the next change against it.",
    );
    expect(W.holdLine({ counted: 10, adoptedAt: "2027-01-14T09:00:00.000Z", now: new Date() })).toBeNull();
    expect(say(W.tooFewYet(4))).toBe("Too few to check yet: 4 of the 10 votes it needs.");
  });

  it("gives each status its form", () => {
    const at = (d: string) => `2027-${d}T09:00:00.000Z`;
    expect(say(W.statusLine({ v: 1, createdBy: "auto", setBy: "learned", createdAt: at("01-14"), hasLook: true }, { brand: false }))).toBe("Learned 14 Jan");
    expect(say(W.statusLine({ v: 3, createdBy: "auto", setBy: "learned", createdAt: at("01-18"), hasLook: true }, { brand: false }))).toBe("Version 3, learned 18 Jan");
    expect(say(W.statusLine({ v: 2, createdBy: "person", setBy: "person", createdAt: at("05-30"), hasLook: true }, { brand: false }))).toBe("Set by you on 30 May");
    expect(say(W.statusLine({ v: 5, createdBy: "revert", setBy: "learned", createdAt: at("04-26"), hasLook: true }, { brand: false }))).toBe("Version 5, back to version 3's look on 26 Apr");
    const first = { v: 1, createdBy: "auto", setBy: "learned", createdAt: at("01-14"), hasLook: true };
    expect(say(W.statusLine({ v: 3, createdBy: "undo", setBy: "learned", createdAt: at("05-30"), hasLook: true }, { brand: false, restoredFirst: first }))).toBe("Learned 14 Jan, back in use on 30 May");
    expect(say(W.statusLine({ v: 2, createdBy: "undo", setBy: "learned", createdAt: at("05-30"), hasLook: false }, { brand: false }))).toBe("No look of its own again");
    expect(say(W.statusLine({ v: 0, createdBy: "auto", createdAt: "", hasLook: false }, { brand: false }))).toBe("No look of its own yet");
    expect(say(W.statusLine({ v: 2, createdBy: "undo", createdAt: at("05-30"), hasLook: false }, { brand: true }))).toBe("No look yet");
    expect(say(W.statusLine({ v: 3, createdBy: "forget", createdAt: at("05-30"), hasLook: false }, { brand: false }))).toBe("Forgotten on 30 May");
  });

  it("writes History, each replaced version with the read that let it change", () => {
    const at = (d: string) => `2027-${d}T09:00:00.000Z`;
    const cantCheck = readOf([3, 5, 2, 4], [0, 5, 0, 4], 5);
    expect(say(W.historyLine({ v: 1, createdBy: "auto", setBy: "learned", createdAt: at("01-14"), hasLook: true, evidenceCounts: { liked: 3, disliked: 2, newestAt: null } }, { inUse: false, read: cantCheck }))).toBe(
      "Version 1, 14 Jan, learned from 3 images you liked and 2 you didn't. Can't be checked: only 5 votes came before it.",
    );
    expect(say(W.historyLine({ v: 2, createdBy: "person", setBy: "person", createdAt: at("05-30"), hasLook: true, who: "you" }, { inUse: true }))).toBe("Version 2, 30 May, set by you. In use.");
    expect(say(W.historyLine({ v: 1, createdBy: "seed", setBy: "seeded", createdAt: "2026-12-02T09:00:00.000Z", hasLook: true }, { inUse: false }))).toBe(
      "Version 1, 2 Dec, carried over from before YouGrow kept versions. Can't be checked: nothing came before it.",
    );
    expect(say(W.historyLine({ v: 2, createdBy: "auto", setBy: "learned", createdAt: "2026-12-09T09:00:00.000Z", hasLook: true, evidenceCounts: { liked: 18, disliked: 7, newestAt: null } }, { inUse: false, read: readOf([14, 40, 34, 40]) }))).toBe(
      "Version 2, 9 Dec, learned from 18 images you liked and 7 you didn't. Liked more often: 34 of 40 against 14 of 40 before.",
    );
    expect(say(W.historyLine({ v: 4, createdBy: "undo", setBy: "learned", createdAt: at("02-03"), hasLook: true, who: "a teammate" }, { inUse: true }))).toBe(
      "Version 4, 3 Feb, back to version 2's look by a teammate. In use.",
    );
    expect(say(W.historyLine({ v: 5, createdBy: "revert", setBy: "learned", createdAt: at("04-26"), hasLook: true, who: "you" }, { inUse: true }))).toBe(
      "Version 5, 26 Apr, back to version 3's look by you, from Review. In use.",
    );
  });

  it("keeps a first look's can't check line off the row, and says the rest", () => {
    const cantCheck = readOf([3, 5, 2, 4], [0, 5, 0, 4], 5);
    expect(W.checkLine(cantCheck, { first: true, counted: 4, since: null })).toBeNull();
    expect(say(W.firstLookCantCheck(cantCheck))).toBe("This first look can't be checked: only 5 votes came before it.");
    expect(W.checkLine(null, { first: true, counted: 0, since: null })).toBeNull();
    expect(W.checkLine(null, { first: false, counted: 0, since: null })).toEqual({ text: "Too few to check yet: 0 of the 10 votes it needs.", tone: "wait" });
    expect(W.checkLine(readOf([14, 40, 34, 40]), { first: false, counted: 40, since: null })).toEqual({ text: "Liked more often: 34 of 40 against 14 of 40 before.", tone: "good" });
    const guard = readOf([20, 40, 20, 40], [4, 40, 20, 40]);
    expect(W.checkLine(guard, { first: false, counted: 40, since: "2027-03-09T09:00:00.000Z" })).toEqual({
      text: "Your images were remade more since 9 Mar: 20 of 40 against 4 of 40 before.",
      tone: "bad",
    });
    expect(W.checkLine(guard, { first: false, counted: 40, since: "2027-03-09T09:00:00.000Z", ask: true })?.text).toBe(
      "Your images were remade more since 9 Mar: 20 of 40 against 4 of 40 before. Go back to the earlier look?",
    );
    expect(say(W.goBackWaiting(3))).toBe("Go back to version 3? It's waiting in Review.");
  });

  it("says what each click did", () => {
    expect(say(W.undoDoneLine({ scope: NATURAL, restored: 0, wasPerson: false, brandLook: true }))).toBe("Undone. Natural photo has no look of its own again, so it uses your brand's look.");
    expect(say(W.undoDoneLine({ scope: NATURAL, restored: 0, wasPerson: false, brandLook: true, panel: true }))).toBe("Undone. Natural photo uses your brand's look again.");
    expect(say(W.undoDoneLine({ scope: BRAND_SCOPE, restored: 0, wasPerson: false, brandLook: false, usingBrand: ["Product still life"] }))).toBe(
      "Undone. Your brand's look is empty again, so Product still life uses the presets.",
    );
    expect(say(W.undoDoneLine({ scope: "image_style.editorial_photo", restored: 2, restoredAt: "2026-12-09T09:00:00.000Z", wasPerson: false, brandLook: true }))).toBe("Back to version 2 from 9 Dec.");
    expect(say(W.undoDoneLine({ scope: NATURAL, restored: 1, restoredAt: "2027-01-14T09:00:00.000Z", wasPerson: true, brandLook: true }))).toBe(
      "Back to the look learned on 14 Jan. YouGrow learns from your votes again.",
    );
    for (const line of [W.FORGET_DONE, W.FORGET_UNDONE_DONE, W.FORGET_OFFER, W.KEPT_DONE, W.GO_BACK_UNDONE, W.OPEN_WHAT_IT_LEARNED, W.RESET_CONFIRM, W.EDIT_HELPER]) say(line);
    const confirm = W.forgetConfirm({ scope: NATURAL, liked: 3, disliked: 2, brandOverlap: 0 });
    expect(confirm.title).toBe("Forget the Natural photo look?");
    expect(say(confirm.body)).toBe("YouGrow stops using it, clears its words, and won't learn again from the 3 images you liked and 2 you didn't that taught it. Your votes stay. This can't be undone.");
    expect(confirm.also).toBeNull();
    const lumen = W.forgetConfirm({ scope: "image_style.editorial_photo", liked: 20, disliked: 8, brandOverlap: 6 });
    expect(say(lumen.also)).toBe("Also forget your brand's look, which learned from 6 of the same images");
    const brand = W.forgetConfirm({ scope: BRAND_SCOPE, liked: 4, disliked: 0, uploaded: 4, brandOverlap: 0 });
    expect(brand.title).toBe("Forget your brand's look?");
    expect(say(brand.body)).toBe("YouGrow stops using it, clears its words, and won't learn again from the 4 photos you uploaded that taught it. Your photos stay. This can't be undone.");
    say(W.forgetUndoneConfirm(NATURAL).title);
    say(W.forgetUndoneConfirm(NATURAL).body);
  });
});

describe("the post image panel and the image details' words", () => {
  it("says how an image was made, from its stamp", () => {
    const stamp = (o: Record<string, unknown>) => ({ arm: "learned", scope: NATURAL, v: 1, ...o });
    expect(say(W.madeLine(stamp({})))).toBe("Made with the Natural photo look, version 1");
    expect(say(W.madeLine(stamp({ scope: BRAND_SCOPE })))).toBe("Made with your brand's look, version 1");
    expect(say(W.madeLine(stamp({ arm: "holdback" })))).toBe("Made without what it learned, as about 1 in 20 images are.");
    expect(say(W.madeLine(stamp({ arm: "none", sources: ["person_off"] })))).toBe("Made with Use learned brand style off.");
    expect(say(W.madeLine(null))).toBe("Made before YouGrow kept versions.");
    expect(W.madeLine(stamp({ arm: "none", scope: "image_style.headline_card", v: 0 }))).toBeNull();
    expect(W.madeLine({ unstamped: "own_image" })).toBeNull();
    expect(say(W.newLookNotice(NATURAL, "2027-01-14T09:00:00.000Z"))).toBe("New look for Natural photo from your likes on 14 Jan.");
    say(W.STANDING_LINE);
    say(W.HELD_BACK_AFTER_VOTE);
  });

  it("thanks a reason in the style's name", () => {
    expect(say(W.reasonDoneLine(NATURAL))).toBe("Thanks. The next Natural photo look takes this into account.");
    expect(say(W.reasonDoneLine(BRAND_SCOPE))).toBe("Thanks. Your brand's next look takes this into account.");
    expect(W.reasonLabelOf("down", "mood")).toBe("Wrong mood or style");
    expect(W.reasonLabelOf("up", "fake")).toBeNull();
  });

  it("words the learning setting for step 4", () => {
    say(W.LEARNING_SETTING.words);
    expect(say(W.learningOffLine("2027-06-03T09:00:00.000Z"))).toBe("Off since 3 Jun. Every image is made with what YouGrow learned.");
  });
});

describe("the help page's check examples", () => {
  it("are the words the real verdict gives", () => {
    const made = [
      verdictWords(readOf([14, 40, 34, 40])),
      verdictWords(readOf([60, 120, 60, 120], [30, 120, 30, 120])),
      verdictWords(readOf([30, 40, 12, 40]), { since: "2027-03-09T10:00:00.000Z", ask: true }),
      verdictWords(readOf([20, 40, 20, 40], [4, 40, 20, 40]), { since: "2027-04-02T10:00:00.000Z", ask: true }),
      verdictWords(readOf([8, 20, 12, 20], [2, 20, 2, 20], 40)),
      verdictWords(readOf([3, 5, 2, 4], [0, 5, 0, 4], 5), { first: true }),
    ];
    expect(W.CHECK_EXAMPLES.map((e) => e.says)).toEqual(made);
    for (const e of W.CHECK_EXAMPLES) say(e.means);
  });
});

describe("every line", () => {
  it("keeps to the writing rules: no dashes as punctuation and no AI tells", () => {
    const constants = (Object.values(W) as unknown[]).filter((v): v is string => typeof v === "string");
    for (const line of [...LINES, ...constants]) expect([...dashesIn(line), ...aiTellsIn(line)], line).toEqual([]);
    expect(LINES.length).toBeGreaterThan(40);
  });
});

