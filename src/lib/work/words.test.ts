import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  askAgainNotice,
  countedLine,
  doneCheckNotice,
  IMPORT_ROW_MESSAGES,
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

describe("Work's words", () => {
  it("keep the house style: no dashes as punctuation and no AI tells", () => {
    const all = [
      ...stringsIn([WORK_MESSAGES, IMPORT_ROW_MESSAGES, WORK_STATUS_LABEL, PLAN_STATE_LABEL]),
      ...LINES.map(countedLine),
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
