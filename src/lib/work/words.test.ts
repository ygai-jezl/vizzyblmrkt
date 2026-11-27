import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { USED_NOTE } from "@/lib/loops/used";
import {
  askAgainNotice,
  countedLine,
  doneCheckNotice,
  IMAGES_OFF_LINE,
  IMPORT_ROW_MESSAGES,
  LOOPS_COUNT_NOTE,
  monthsWords,
  movesWhat,
  nextCheckNotice,
  PLAN_STATE_LABEL,
  purposeResource,
  refHintText,
  thenCheckNotice,
  unknownStatusesText,
  WORK_MESSAGES,
  WORK_STATUS_LABEL,
} from "./words";
import type { CountedLineInput } from "./words";

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

const counted = { from: "2026-11-11T10:00:00.000Z", to: "2026-11-25T08:00:00.000Z", at: "2026-11-25T08:01:00.000Z" };
const event = { kind: "used", counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }, look: { days: 14 } } as const;
const purpose = { kind: "used", counts: { purpose: "content_angle" }, look: { days: 30 } } as const;

const LINES: CountedLineInput[] = [
  { part: event, counted: { ...counted, n: 212 }, brandName: "Lumen Notes", timeZone: "Europe/London" },
  { part: event, counted: { ...counted, n: 1 }, brandName: "Fernhill Plants", timeZone: "Europe/London" },
  { part: event, counted: { ...counted, n: 40, capped: true, backTo: "2026-11-19T12:00:00.000Z" }, brandName: "Lumen Notes", timeZone: "Europe/London" },
  { part: event, counted: null, brandName: "Lumen Notes", timeZone: "UTC" },
  { part: purpose, counted: { ...counted, from: "2026-11-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z", units: 52000, brands: 14 }, brandName: null, timeZone: "UTC" },
  { part: purpose, counted: { ...counted, units: 900, hidden: true }, brandName: null, timeZone: "UTC" },
  { part: purpose, counted: null, brandName: null, timeZone: "UTC", meterOff: true },
  { part: { kind: "used", counts: { type: "work_task" }, look: { days: 7 } }, counted: null, brandName: null, timeZone: "UTC" },
  { part: { kind: "used", counts: { loopKind: "vizzy_chat" }, look: { days: 7 } } as CountedLineInput["part"], counted: null, brandName: null, timeZone: "UTC" },
  { part: { kind: "used", counts: { none: "" }, look: { days: 7 } }, counted: null, brandName: null, timeZone: "UTC" },
  { part: { kind: "moves", meaning: "conversions", direction: "up", word: "Orders", look: { days: 30 } }, counted: null, brandName: "Fernhill", timeZone: "UTC" },
  { part: { kind: "moves", meaning: "openRate", direction: "up", look: { days: 30 } } as CountedLineInput["part"], counted: null, brandName: null, timeZone: "UTC" },
  { part: { kind: "runs_better", what: "crashes", look: { days: 7 } }, counted: null, brandName: "Lumen Notes", timeZone: "UTC" },
];

/** Counts from the learning loops' weekly counts across brands, as Work keeps them on a check. */
const weeksSpan = { from: "2026-11-16T00:00:00.000Z", to: "2026-11-29T23:59:59.999Z", at: "2026-12-05T00:00:00.000Z" };
const typeOf = { kind: "used", counts: { type: "content_plan" }, look: { days: 14 } } as const;
const LOOPS_LINES: CountedLineInput[] = [
  { part: purpose, counted: { ...weeksSpan, n: 1800, weeks: { read: 2, shown: 2, orgs: 12, open: 1, openFrom: "2026-11-30T00:00:00.000Z", older: 0, beforeDone: true } }, brandName: null, timeZone: "UTC", loopsOn: true },
  { part: typeOf, counted: { ...weeksSpan, n: 64, weeks: { read: 2, shown: 1, orgs: 10, open: 0, older: 0 } }, brandName: null, timeZone: "UTC", loopsOn: true },
  { part: typeOf, counted: { ...weeksSpan, from: "2026-08-31T00:00:00.000Z", n: 640, weeks: { read: 13, shown: 11, orgs: 10, open: 2, openFrom: "2026-11-30T00:00:00.000Z", older: 1 } }, brandName: null, timeZone: "UTC", loopsOn: true },
  { part: purpose, counted: { ...weeksSpan, hidden: true, weeks: { read: 2, shown: 0, open: 0, older: 0 } }, brandName: null, timeZone: "UTC", loopsOn: true },
  { part: purpose, counted: { from: "2026-12-01T10:00:00.000Z", to: "2026-12-03T13:00:00.000Z", at: "2026-12-04T09:00:00.000Z", weeks: { read: 0, shown: 0, open: 1, openFrom: "2026-11-30T00:00:00.000Z", older: 0 } }, brandName: null, timeZone: "UTC", loopsOn: true },
  { part: { kind: "used", counts: { loopKind: "post_image" }, look: { days: 14 } } as CountedLineInput["part"], counted: { ...weeksSpan, n: 160, weeks: { read: 2, shown: 2, orgs: 11, open: 0, older: 0, row: "image_style" } }, brandName: null, timeZone: "UTC", loopsOn: true },
];

describe("Work's words", () => {
  it("keep the house style: no dashes as punctuation and no AI tells", () => {
    const all = [
      ...stringsIn([WORK_MESSAGES, IMPORT_ROW_MESSAGES, WORK_STATUS_LABEL, PLAN_STATE_LABEL]),
      ...LINES.map(countedLine),
      ...LINES.map((l) => countedLine({ ...l, loopsOn: true })),
      ...LOOPS_LINES.map(countedLine),
      LOOPS_COUNT_NOTE,
      doneCheckNotice("2026-12-04T08:00:00.000Z", "Europe/London", true),
      askAgainNotice("2026-12-11T08:00:00.000Z", "Europe/London"),
      nextCheckNotice("2026-11-21T08:00:00.000Z", "Europe/London"),
      thenCheckNotice("2027-01-19T08:00:00.000Z", "Europe/London"),
      unknownStatusesText(["Idea", "Someday", "Later"]),
      refHintText(81),
    ];
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
    }
  });

  it("say what Work counted for a product event, exact or capped, in the brand's own days", () => {
    expect(countedLine(LINES[0]!)).toBe("Work counted 212 note_from_template events from Lumen Notes' product since 11 Nov.");
    expect(countedLine(LINES[1]!)).toBe("Work counted 1 note_from_template event from Fernhill Plants' product since 11 Nov.");
    expect(countedLine(LINES[2]!)).toBe("Work counted at least 40 note_from_template events from Lumen Notes' product in the newest 2,000 events, back to 19 Nov.");
    expect(countedLine(LINES[3]!)).toBe("Work counts it once the check is due.");
  });

  it("name a product event by its catalog label when it has one, as the picker does", () => {
    const label = "Notes made from a template";
    expect(countedLine({ ...LINES[0]!, eventLabel: label })).toBe("Work counted 212 notes made from a template from Lumen Notes' product since 11 Nov.");
    expect(countedLine({ ...LINES[1]!, eventLabel: label })).toBe("Work counted 1 event for notes made from a template from Fernhill Plants' product since 11 Nov.");
    expect(countedLine({ ...LINES[2]!, eventLabel: label })).toBe("Work counted at least 40 notes made from a template from Lumen Notes' product in the newest 2,000 events, back to 19 Nov.");
  });

  it("say what a purpose spent over its months, hiding the brands below 10 organisations, and that it can't count with the meter off", () => {
    expect(countedLine(LINES[4]!)).toBe("Work counted 52,000 tokens spent on suggesting angles in Nov and Dec 2026, by 14 brands. The month totals include days before Done.");
    expect(countedLine(LINES[5]!)).toBe(
      "Work counted 900 tokens spent on suggesting angles in Nov 2026. How many brands used it stays hidden until they come from 10 organisations. The month totals include days before Done.",
    );
    expect(countedLine(LINES[6]!)).toBe("Work can't count suggesting angles while the usage meter is off, so your read is the record.");
  });

  it("name what Work can't count, with no yet for Runs better", () => {
    expect(countedLine(LINES[7]!)).toBe("Work can't count work task records yet, so your read is the record.");
    expect(countedLine(LINES[9]!)).toBe("Work counts nothing for this one, so your read is the record.");
    expect(countedLine(LINES[10]!)).toBe("Work can't count orders for Fernhill yet, so your read is the record.");
    expect(countedLine(LINES[11]!)).toBe("Work can't count open rate yet, so your read is the record.");
    expect(countedLine(LINES[12]!)).toBe("Work can't count crashes, so your read is the record.");
    expect(movesWhat({ meaning: "conversions", word: "Sign ups" })).toBe("sign ups");
  });

  it("say what a count from the learning loops covers: the weeks shown and left out, the organisations, and what it can miss", () => {
    expect(countedLine(LOOPS_LINES[1]!)).toBe(
      `Work counted about 64 content plan records made across brands in 1 of the 2 weeks from 16 Nov to 29 Nov, from 10 organisations. Each organisation counts up to 20 a week. The other week didn't have counts from 10 organisations yet, so it is left out. ${LOOPS_COUNT_NOTE}`,
    );
    expect(countedLine(LOOPS_LINES[2]!)).toBe(
      `Work counted about 640 content plan records made across brands in 11 of the 13 weeks from 31 Aug to 29 Nov, from at least 10 organisations a week. Each organisation counts up to 20 a week. The other 2 weeks didn't have counts from 10 organisations yet, so they are left out. Work reads the newest 13 weeks, so the week before them is left out. The 2 weeks from 30 Nov aren't over yet, so they aren't counted. ${LOOPS_COUNT_NOTE}`,
    );
    expect(countedLine(LOOPS_LINES[3]!)).toBe(
      `Work counted AI calls for suggesting angles across brands in the 2 weeks from 16 Nov to 29 Nov. How many isn't shown: no week had counts from 10 organisations yet. ${LOOPS_COUNT_NOTE}`,
    );
    expect(countedLine(LOOPS_LINES[4]!)).toBe("Work counts AI calls for suggesting angles across brands in whole weeks, and the week of 30 Nov isn't over yet, so your read is the record.");
    // A purpose's line says the meter is off first, as it does for the walk's count.
    expect(countedLine({ ...LOOPS_LINES[0]!, meterOff: true })).toBe(countedLine(LINES[6]!));
    // Uses are never capped: only things made say the cap.
    expect(countedLine(LOOPS_LINES[0]!)).not.toContain("counts up to");
    expect(countedLine(LOOPS_LINES[5]!)).toContain("counts up to 20 a week");
  });

  it("say every point of USED_NOTE in Work's own words", () => {
    const points: Array<[RegExp, RegExp]> = [
      [/added once and never retried/, /fails to save isn't tried again/],
      [/own uploads are left out/, /own uploads aren't counted/],
      [/nothing is counted while the learning loops are off/, /nothing is counted while the learning loops are off/],
      [/brands that opted out are left out/, /brands that opted out are left out/],
      [/a short week undercounts/, /a week some brands didn't report counts less/],
      [/counts lag up to a week/, /counts can take up to a week to come in/],
    ];
    for (const [note, work] of points) {
      expect(USED_NOTE).toMatch(note);
      expect(LOOPS_COUNT_NOTE).toMatch(work);
    }
    expect(USED_NOTE.split(",").length).toBe(LOOPS_COUNT_NOTE.split(",").length);
  });

  it("wait for the check to count a type or a LOOPS kind with the loops on, and say it can't be counted yet with them off", () => {
    expect(countedLine({ ...LINES[7]!, loopsOn: true })).toBe("Work counts it once the check is due.");
    expect(countedLine({ ...LINES[8]!, loopsOn: true })).toBe("Work counts it once the check is due.");
    expect(countedLine(LINES[8]!)).toBe("Work can't count vizzy_chat yet, so your read is the record.");
  });

  it("say an image kind can't be counted while image learning is off on this copy, never that it counts once due", () => {
    const image = { part: { kind: "used", counts: { loopKind: "post_image" }, look: { days: 14 } } as CountedLineInput["part"], counted: null, brandName: null, timeZone: "UTC", loopsOn: true };
    expect(countedLine({ ...image, imagesOff: true })).toBe(IMAGES_OFF_LINE);
    expect(countedLine(image)).toBe("Work counts it once the check is due.");
    // A count kept from when images were counted still reads as one.
    expect(countedLine({ ...LOOPS_LINES[5]!, imagesOff: true })).toMatch(/^Work counted about 160 images made/);
    expect([...dashesIn(IMAGES_OFF_LINE), ...aiTellsIn(IMAGES_OFF_LINE)]).toEqual([]);
  });

  it("count a purpose in the resource that lists fewest purposes", () => {
    expect(purposeResource("autopilot")).toBe("autopilot_drafts");
    expect(purposeResource("blog_research")).toBe("web_searches");
    expect(purposeResource("vizzy_chat")).toBe("model_tokens");
    expect(purposeResource("post_image")).toBe("images");
    expect(purposeResource("nothing")).toBeNull();
  });

  it("say months and notices plainly", () => {
    expect(monthsWords("2026-11", "2026-11")).toBe("Nov 2026");
    expect(monthsWords("2026-11", "2026-12")).toBe("Nov and Dec 2026");
    expect(monthsWords("2026-12", "2027-02")).toBe("Dec 2026 to Feb 2027");
    expect(doneCheckNotice("2026-12-04T08:00:00.000Z", "Europe/London", false)).toBe("It asks if it worked on 4 Dec at 08:00.");
    expect(doneCheckNotice("2026-12-04T08:00:00.000Z", "Europe/London", true)).toBe("It asks if it worked on 4 Dec at 08:00, in place of the check that was set.");
    expect(unknownStatusesText(["Someday"])).toBe("1 status isn't one of Work's, so Someday comes in as To do.");
    expect(unknownStatusesText(["Idea", "Someday"])).toBe("2 statuses aren't Work's, so Idea and Someday come in as To do.");
    expect(unknownStatusesText([])).toBe("");
  });
});
