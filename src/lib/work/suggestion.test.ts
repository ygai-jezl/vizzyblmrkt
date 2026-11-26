import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { AgentAction } from "@/lib/types/agentAction";
import { checkDoneLine, measureCheckDetail, READ_LABEL, readyDetail, startedLine, WORK_REVIEW_COPY } from "./reviewCards";
import { originParts, SUGGESTED_FIELD_LABEL } from "./screenWords";
import {
  addBodyOf,
  addedToWorkLine,
  againAfter,
  DECLINE_WHY_CHOICES,
  DECLINE_WHY_LABEL,
  dismissedLine,
  editedFields,
  fromWords,
  measureContent,
  seesSuggestion,
  stageTag,
  suggestedMeasureText,
  SuggestedTaskSchema,
  suggestionOf,
  WORK_SUGGEST_ACTION,
  type SuggestedTask,
} from "./suggestion";

// A task Vizzy suggests for Work, and the words on Review's Work cards. Made-up Lumen and Fernhill Plants.

const lumen: SuggestedTask = {
  title: "Check the team plan test accounts after tonight's runs",
  description: "After tonight's runs, check both team plan test accounts got answers, and log what they found.",
  stage: "build",
  brandId: "ten_lumen",
  typedLinks: [],
  measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
  proposed: { kind: "runs_better", reason: "It checks a nightly run." },
  from: "from today's log: Competitor pricing research",
  why: "You logged Competitor pricing research as waiting on tonight's runs.",
};

const fernhill: SuggestedTask = {
  title: "Tell the workshop waitlist the three dates",
  description: "",
  stage: "test",
  brandId: null,
  typedLinks: [{ kind: "idea", brandId: "ten_fernhill", ideaId: "cmp_workshops" }],
  measure: { kind: "moves", meaning: "clickRate", look: { days: 7 } },
  proposed: { kind: "moves", reason: "It sends an email to the waitlist." },
  from: "from today's log",
  why: "Rosa logged three Saturdays this morning.",
};

describe("a suggested task", () => {
  it("never sets Must have: the shape refuses it", () => {
    expect(SuggestedTaskSchema.safeParse(lumen).success).toBe(true);
    expect(SuggestedTaskSchema.safeParse({ ...lumen, mustHave: true }).success).toBe(false);
    expect(SuggestedTaskSchema.safeParse({ ...lumen, mustHave: false }).success).toBe(false);
    // Nor an origin, a proposal's by, or anything else the server sets.
    expect(SuggestedTaskSchema.safeParse({ ...lumen, origin: { kind: "person", by: "uid_sam" } }).success).toBe(false);
    expect(SuggestedTaskSchema.safeParse({ ...lumen, proposed: { ...lumen.proposed, by: "rule" } }).success).toBe(false);
  });

  it("names a measure of the kind Vizzy proposes", () => {
    expect(SuggestedTaskSchema.safeParse({ ...lumen, proposed: { kind: "done", reason: "Legal work in Set up." } }).success).toBe(false);
    expect(SuggestedTaskSchema.safeParse({ ...lumen, measure: null, proposed: { kind: "done", reason: "Legal work in Set up." } }).success).toBe(true);
  });

  it("is read from a Work suggestion's proposal.task only, never from fields", () => {
    const a = (over: Partial<AgentAction>) => ({ action: WORK_SUGGEST_ACTION, proposal: { task: lumen }, ...over }) as AgentAction;
    expect(suggestionOf(a({}))).toEqual(lumen);
    expect(suggestionOf(a({ action: "person_fields.suggest" }))).toBeNull();
    expect(suggestionOf(a({ proposal: { fields: lumen } }))).toBeNull();
    expect(suggestionOf(a({ proposal: null }))).toBeNull();
    expect(suggestionOf(a({ proposal: { task: { ...lumen, mustHave: true } } }))).toBeNull();
  });

  it("is seen by those who see its brand: everyone in the organisation view, a brand's own team in the brand view", () => {
    const org = { view: "organisation" as const, session: { id: "ten_lumen" } };
    const brand = { view: "brand" as const, session: { id: "ten_lumen" } };
    expect(seesSuggestion(org, { brandId: null })).toBe(true);
    expect(seesSuggestion(org, { brandId: "ten_lumen-eu" })).toBe(true);
    expect(seesSuggestion(brand, { brandId: "ten_lumen" })).toBe(true);
    expect(seesSuggestion(brand, { brandId: null })).toBe(false);
    expect(seesSuggestion(brand, { brandId: "ten_lumen-eu" })).toBe(false);
  });

  it("adds as it is, To do, with no Must have", () => {
    expect(addBodyOf(lumen)).toEqual({ title: lumen.title, description: lumen.description, status: "todo", stage: "build", brandId: "ten_lumen", typedLinks: [], measure: lumen.measure });
    expect(addBodyOf(fernhill)).not.toHaveProperty("description");
    expect(addBodyOf(fernhill)).not.toHaveProperty("mustHave");
  });
});

describe("what the person edited", () => {
  it("is nothing for the suggestion as written, and ticking Must have is never an edit", () => {
    expect(editedFields(lumen, addBodyOf(lumen))).toEqual([]);
    expect(editedFields(lumen, { ...addBodyOf(lumen), mustHave: true })).toEqual([]);
    // The add page sends the description as typed and the direction filled in: the same measure.
    expect(editedFields(fernhill, { ...addBodyOf(fernhill), description: "  ", measure: { kind: "moves", meaning: "clickRate", direction: "up", look: { days: 7 }, then: null } })).toEqual([]);
  });

  it("names each field changed, and the kind of win when it changed", () => {
    const body = { ...addBodyOf(lumen), title: "Check both test accounts", stage: "support" as const, measure: { kind: "done" as const } };
    expect(editedFields(lumen, body)).toEqual(["title", "stage", "measure", "measure.kind"]);
    // A new look on the same kind is a measure edit, not a kind change.
    expect(editedFields(lumen, { ...addBodyOf(lumen), measure: { kind: "runs_better", what: "errors", look: { days: 14 } } })).toEqual(["measure"]);
    expect(editedFields(fernhill, { ...addBodyOf(fernhill), brandId: "ten_fernhill", typedLinks: [] })).toEqual(["brandId", "typedLinks"]);
    expect(editedFields(lumen, { ...addBodyOf(lumen), measure: null })).toEqual(["measure", "measure.kind"]);
  });

  it("compares measures by content", () => {
    expect(measureContent({ kind: "moves", meaning: "clickRate", look: { days: 7 } })).toBe(measureContent({ kind: "moves", meaning: "clickRate", direction: "up", look: { days: 7 }, then: null }));
    expect(measureContent({ kind: "moves", meaning: "clickRate", look: { days: 7 } })).not.toBe(measureContent({ kind: "moves", meaning: "clickRate", direction: "down", look: { days: 7 } }));
    expect(measureContent(null)).toBe("null");
  });
});

describe("dismissing", () => {
  it("lets Vizzy suggest it again after Not now only", () => {
    expect(againAfter("not_now")).toBe("30_days");
    for (const why of ["not_for_us", "already_on_it", "wrong", undefined, null] as const) expect(againAfter(why)).toBe("never");
    expect(DECLINE_WHY_CHOICES.map((c) => c.label)).toEqual(["Not now", "Not for us", "Already on it", "Wrong"]);
  });

  it("says so in the done line", () => {
    expect(dismissedLine("Tell the workshop waitlist the three dates", "not_now")).toBe("Dismissed “Tell the workshop waitlist the three dates”: Not now. Vizzy can suggest it again in 30 days.");
    expect(dismissedLine("Tell the workshop waitlist the three dates", "not_for_us")).toBe("Dismissed “Tell the workshop waitlist the three dates”: Not for us. Vizzy won't suggest it again.");
    expect(dismissedLine("Tell the workshop waitlist the three dates", null)).toBe("Dismissed “Tell the workshop waitlist the three dates”. Vizzy won't suggest it again.");
  });
});

const ORIGIN = { kind: "suggestion" as const, agent: "vizzy" as const, agentActionId: `aa_${"5".repeat(40)}` as const, evidence: [], by: "uid_nina" };

describe("the task page's origin line", () => {
  it("says where Vizzy wrote it from, and whether it was edited before adding", () => {
    expect(originParts(ORIGIN, "2026-11-18T10:00:00.000Z", "Europe/London", "uid_nina", {}, { from: "from Rosa's log", edited: true })).toEqual({
      from: "From Vizzy:",
      rest: "from Rosa's log. Added by you on 18 Nov, edited before adding.",
    });
    expect(originParts(ORIGIN, "2026-11-18T10:00:00.000Z", "Europe/London", "uid_sam", { uid_nina: "Nina" }, { from: "from your numbers", edited: false }).rest).toBe("from your numbers. Added by Nina on 18 Nov.");
    // When the suggestion can't be read, the line stands on the origin alone.
    expect(originParts(ORIGIN, "2026-11-18T10:00:00.000Z", "Europe/London", "uid_nina", {}).rest).toBe("added from its suggestion by you on 18 Nov.");
  });
});

describe("the cards", () => {
  it("say how we'll know it worked as the task page does", () => {
    expect(suggestedMeasureText(lumen)).toBe("Runs better: errors, 7 days after it's done.");
    expect(suggestedMeasureText(fernhill)).toBe("Moves a number: click rate up, 7 days after it's done.");
    expect(suggestedMeasureText({ measure: { kind: "done" }, proposed: { kind: "done", reason: "Legal work in Set up." } })).toBe("Done is the win.");
    expect(suggestedMeasureText({ measure: null, proposed: { kind: "used", reason: "It names a switch." } })).toBe("Used.");
    expect(suggestedMeasureText({ measure: null, proposed: null })).toBeNull();
    expect(fromWords("from today's log")).toBe("From today's log");
    expect(stageTag("build")).toEqual({ n: 4, label: "Build" });
    expect(stageTag(null)).toBeNull();
  });

  it("say what a tap did", () => {
    expect(checkDoneLine(69, { action: "checked" }, null)).toBe("#69 checked. It's off Review, and its history says you checked it today.");
    expect(checkDoneLine(69, { action: "look_again" }, "Next check on 26 Nov at 08:00.")).toBe("#69: next check tomorrow at 08:00. It's off Review until then.");
    expect(checkDoneLine(57, { action: "read", read: "too_soon" }, "It asks again on 2 Dec at 08:00.")).toBe("#57 checked: Too soon to tell. It asks again on 2 Dec at 08:00. It's off Review until then.");
    expect(checkDoneLine(57, { action: "read", read: "better" }, "The then's check is on 10 Jan at 08:00.")).toBe("#57 checked: Better. The then's check is on 10 Jan at 08:00.");
    expect(checkDoneLine(62, { action: "read", read: "same" }, null)).toBe("#62 checked: Same. Nothing else is due on it.");
    expect(startedLine(80, "Import from other note apps")).toBe("Started #80 Import from other note apps. It's In progress, and Work keeps that you picked it.");
    expect(addedToWorkLine(82, "Add a data processing agreement for team admins")).toBe("Added to Work as #82 Add a data processing agreement for team admins, To do.");
    expect(readyDetail({ stage: "4 Build", brand: "Lumen for Teams", since: "21 Nov" })).toBe("4 Build · Lumen for Teams · To do since 21 Nov. Nothing blocks it.");
    expect(readyDetail({ stage: null, brand: null, since: "21 Nov" })).toBe("To do since 21 Nov. Nothing blocks it.");
    expect(measureCheckDetail("Runs better: crashes, 7 days after it's done.")).toBe("Did it work? Runs better: crashes, 7 days after it's done.");
  });

  it("keep the house style: no dashes as punctuation and no AI tells, in the words and in the Review rows' literals", () => {
    const all = [
      ...Object.values(WORK_REVIEW_COPY),
      ...Object.values(READ_LABEL),
      ...Object.values(DECLINE_WHY_LABEL),
      dismissedLine("A", "not_now"),
      dismissedLine("A", "wrong"),
      dismissedLine("A", undefined),
      checkDoneLine(1, { action: "checked" }, null),
      checkDoneLine(1, { action: "look_again" }, null),
      checkDoneLine(1, { action: "read", read: "too_soon" }, "It asks again on 2 Dec at 08:00."),
      checkDoneLine(1, { action: "read", read: "worse" }, null),
      startedLine(1, "A"),
      addedToWorkLine(1, "A"),
      readyDetail({ stage: "1 Idea", brand: "Lumen Notes", since: "1 Dec" }),
      ...Object.values(SUGGESTED_FIELD_LABEL),
      ...Object.values(originParts(ORIGIN, "2026-11-18T10:00:00.000Z", "Europe/London", "uid_nina", {}, { from: "from Rosa's log", edited: true })),
    ];
    const rows = readFileSync(join(process.cwd(), "src", "components", "admin", "review", "WorkRows.tsx"), "utf8");
    all.push(...[...rows.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)].map((m) => m[1]!.trim()).filter(Boolean));
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
    }
  });
});
