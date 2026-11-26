import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  addedLine,
  afterTaskDueLine,
  logRegionsDownText,
  brandHint,
  changeWords,
  checkSideLine,
  dayNWords,
  dayTitle,
  emptyText,
  emptyTitle,
  ENTRY_STATE_LABEL,
  IMPORT_FIELD_LABEL,
  importButton,
  importedText,
  initialsOf,
  keptLine,
  listSubLine,
  logSubLine,
  lookWords,
  MEASURE_KIND_HINT,
  MEASURE_KIND_LABEL,
  measureHint,
  memberBrandNote,
  missingColumnsText,
  nextRefLine,
  originParts,
  partLine,
  possessive,
  previewHint,
  productEventHint,
  proposedLine,
  railLabel,
  regionsDownText,
  RUNS_BETTER_LABEL,
  runsBetterHint,
  suggestionFromLine,
  suggestionLine,
  tasksTabLabel,
  unreadableText,
  vizzyWroteLine,
  whenWords,
  whoWords,
  winLine,
  WORK_COPY,
  zoneHint,
} from "./screenWords";
import { WORK_CHANGE_FIELDS, type Measure } from "./types";

// The words Work's screens say. Made-up Lumen, Fernhill Plants and their people.

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

const SET = { setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z" };
const used: Measure = { kind: "used", counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }, look: { days: 14 }, ...SET, then: { kind: "moves", meaning: "conversions", direction: "up", word: "Sign ups", look: { days: 60 } }, proposed: { kind: "used", reason: "It names a switch, so the win is people using what the switch turns on.", by: "rule" } };
const runs: Measure = { kind: "runs_better", what: "crashes", look: { days: 7 }, ...SET, proposed: { kind: "moves", reason: "It is for the brand, so the win is a number that moves for the brand.", by: "vizzy" } };

describe("Work's screen words", () => {
  it("keep the house style: no dashes as punctuation and no AI tells", () => {
    const names = { uid_sam: "Sam" };
    const all = [
      ...stringsIn([WORK_COPY, MEASURE_KIND_LABEL, MEASURE_KIND_HINT, RUNS_BETTER_LABEL, ENTRY_STATE_LABEL, IMPORT_FIELD_LABEL]),
      listSubLine({ name: "Lumen", view: "organisation", brandCount: 2, empty: false, vizzy: true }),
      listSubLine({ name: "Lumen Notes", view: "brand", brandCount: 2, empty: false, vizzy: false }),
      listSubLine({ name: "Fernhill Plants", view: "organisation", brandCount: 1, empty: true, vizzy: false }),
      memberBrandNote("Lumen Notes"),
      emptyTitle("Fernhill Plants"),
      emptyText(true),
      emptyText(false),
      regionsDownText(["Europe", "Asia"]),
      logRegionsDownText(["Europe"]),
      afterTaskDueLine(75),
      unreadableText(2),
      partLine(used as Extract<Measure, { kind: "used" }>),
      proposedLine(used)!,
      proposedLine(runs)!,
      suggestionLine(null),
      suggestionLine({ kind: "done", reason: "Set up work is finished once it is done, so there is nothing to look at after." }, "vizzy"),
      keptLine("runs_better", "moves", "vizzy"),
      productEventHint("Lumen's connected product"),
      runsBetterHint("memory"),
      measureHint({ status: "todo" }, used)!,
      ...WORK_CHANGE_FIELDS.flatMap((f) => [changeWords(f, "todo", "done"), changeWords(f, null, null)]),
      ...Object.values(originParts({ kind: "import", by: "uid_sam", importId: "wi_0123456789abcdef", row: 4, file: "Backlog.csv" }, SET.setAt, "Europe/London", "uid_nina", names)),
      checkSideLine({ kind: "date", at: "2026-12-09T08:00:00.000Z", byMeasure: true, due: false, timeZone: "Europe/London" }),
      logSubLine("Fernhill Plants"),
      addedLine(81, "Register for VAT"),
      nextRefLine(81),
      zoneHint("Lumen Notes", "Europe/London"),
      brandHint("Lumen for Teams"),
      missingColumnsText(["Stage", "Brand", "Check"]),
      importedText(12, 2),
      importButton(12),
      previewHint(40),
      suggestionFromLine("from today's log"),
      vizzyWroteLine("Invites for shared notebooks"),
    ];
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
    }
  });

  it("keep the house style in Work's screens themselves", () => {
    const dir = join(process.cwd(), "src", "components", "admin", "work");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      const text = readFileSync(join(dir, f), "utf8");
      // Only the words people read: string literals and JSX text, not class names or code.
      const literals = [...text.matchAll(/"([^"\n]{3,})"|>\s*([^<>{}\n]{3,})\s*</g)].map((m) => m[1] ?? m[2] ?? "").filter((s) => /[a-z] [a-z]/i.test(s) && !/^[a-z0-9:[\]/_.-]+( [a-z0-9:[\]/_.%()-]+)*$/.test(s));
      for (const s of literals) {
        expect(dashesIn(s), `${f}: ${s}`).toEqual([]);
        expect(aiTellsIn(s), `${f}: ${s}`).toEqual([]);
      }
    }
  });

  it("say who did it: you, a team member, Vizzy, Work, or someone who left", () => {
    const names = { uid_sam: "Sam Okafor" };
    expect(whoWords({ kind: "person", id: "uid_nina" }, "uid_nina", names)).toBe("You");
    expect(whoWords({ kind: "person", id: "uid_sam" }, "uid_nina", names)).toBe("Sam Okafor");
    expect(whoWords({ kind: "person", id: "uid_gone" }, "uid_nina", names)).toBe("Former team member");
    expect(whoWords({ kind: "vizzy", id: null }, "uid_nina", names)).toBe("Vizzy");
    expect(whoWords({ kind: "system", id: null }, "uid_nina", names)).toBe("Work");
    expect(initialsOf("Sam Okafor")).toBe("SO");
    expect(initialsOf("You")).toBe("YO");
    expect(possessive("Lumen Notes")).toBe("Lumen Notes'");
    expect(possessive("Fernhill")).toBe("Fernhill's");
  });

  it("say where a task came from", () => {
    const names = { uid_sam: "Sam" };
    expect(originParts({ kind: "person", by: "uid_sam" }, "2026-11-18T10:00:00.000Z", "Europe/London", "uid_nina", names)).toEqual({ from: "Added by Sam", rest: "on 18 Nov." });
    expect(originParts({ kind: "import", by: "uid_nina", importId: "wi_0123456789abcdef", row: 4, file: "Backlog.csv" }, "2026-11-02T17:31:00.000Z", "Europe/London", "uid_nina", names)).toEqual({ from: "Imported from Backlog.csv", rest: "by you on 2 Nov, row 4." });
    expect(originParts({ kind: "suggestion", agent: "vizzy", agentActionId: `aa_${"1".repeat(40)}`, evidence: [], by: "uid_nina" }, "2026-11-18T10:00:00.000Z", "UTC", "uid_nina", names).from).toBe("From Vizzy:");
  });

  it("say each change with its before and after", () => {
    const brandName = (id: string) => (id === "ten_lumen" ? "Lumen Notes" : undefined);
    expect(changeWords("status", "todo", "in_progress")).toBe("moved it from To do to In progress");
    expect(changeWords("stage", "build", "market")).toBe("moved it from 4 Build to 5 Market");
    expect(changeWords("stage", null, "set_up")).toBe("set the stage to 3 Set up");
    expect(changeWords("mustHave", false, true)).toBe("marked it Must have");
    expect(changeWords("brandId", null, "ten_lumen", { brandName })).toBe("tagged it Lumen Notes");
    expect(changeWords("brandId", "ten_lumen", null)).toBe("made it a whole business task");
    expect(changeWords("notes", "", "Two quotes so far")).toBe("changed the notes to “Two quotes so far”");
    expect(changeWords("check", null, "too_soon")).toBe("read the check: Too soon to tell");
    expect(changeWords("check", null, "checked")).toBe("marked the check done");
    expect(changeWords("added", null, null, { tool: "import" })).toBe("imported it");
    expect(changeWords("check", null, null, { tool: "work_count" })).toBe("counted the check");
  });

  it("read a measure one way everywhere", () => {
    expect(winLine(used)).toBe("Used, then Moves a number");
    expect(winLine(null)).toBeNull();
    expect(lookWords({ days: 1 })).toBe("1 day after it's done");
    expect(lookWords({ outputs: 20 })).toBe("after 20 outputs");
    expect(partLine(used as Extract<Measure, { kind: "used" }>, { connection: () => "Lumen app" })).toBe("Used: note_from_template events from Lumen app, 14 days after it's done.");
    expect(partLine({ kind: "moves", meaning: "conversions", direction: "up", word: "Orders", look: { days: 14 } })).toBe("Moves a number: orders up, 14 days after it's done.");
    expect(proposedLine(used)).toBe("Suggested: Used. It names a switch, so the win is people using what the switch turns on. You kept it.");
    expect(proposedLine(runs)).toBe("Vizzy suggested Moves a number. It is for the brand, so the win is a number that moves for the brand. Runs better was picked over it.");
    expect(measureHint({ status: "in_progress" }, used)).toBe("The 14 days start when it's done. Then it asks: did it work? Better, Same, Worse or Too soon to tell. The then waits for that read.");
    expect(measureHint({ status: "done" }, used)).toBeNull();
    expect(runsBetterHint("crashes")).toBe("Work can't count crashes, so your read is the record.");
  });

  it("date checks and days in the brand's zone", () => {
    expect(checkSideLine({ kind: "date", at: "2026-12-09T08:00:00.000Z", byMeasure: false, due: false, timeZone: "Europe/London" })).toBe("On 9 Dec at 08:00.");
    expect(checkSideLine({ kind: "date", at: "2026-12-09T13:00:00.000Z", byMeasure: false, due: false, timeZone: "America/New_York" })).toBe("On 9 Dec at 08:00.");
    expect(checkSideLine({ kind: "after_task", at: null, byMeasure: false, due: false, timeZone: "UTC", afterRef: 75 })).toBe("When #75 is done");
    expect(whenWords("2026-11-25T10:20:00.000Z", "Europe/London", "2026-11-25")).toBe("Today, 10:20");
    expect(whenWords("2026-11-24T16:40:00.000Z", "Europe/London", "2026-11-25")).toBe("24 Nov, 16:40");
    expect(dayTitle("2026-11-25")).toBe("Wednesday 25 Nov");
    expect(railLabel("2026-11-25")).toBe("Wed 25 Nov");
    expect(dayNWords(3, false)).toBe("Day 3");
    expect(tasksTabLabel(12)).toBe("Tasks · 12 open");
    expect(tasksTabLabel(null)).toBe("Tasks");
  });
});
