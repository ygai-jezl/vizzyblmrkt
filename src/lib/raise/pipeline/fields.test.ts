import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { boardKind, isSetUp, kindsOf, raiseFieldsOf } from "./fields";

const at = "2026-11-01T00:00:00.000Z";
const field = (key: string, label: string, type: RecordField["type"], extra: Partial<RecordField> & { preset?: string } = {}) =>
  ({ key, label, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;
const opt = (id: string, label: string, preset?: string, archivedAt: string | null = null) => ({ id, label, archivedAt, ...(preset ? { preset } : {}) });

const STAGE = field("fld_stage0000001", "Pipeline", "status", {
  preset: "raise.stage",
  options: [opt("opt_research", "Research", "research"), opt("opt_meeting1", "Meeting"), opt("opt_moneyin1", "Money in", "money_in"), opt("opt_passed01", "Passed", "passed"), opt("opt_oldstage", "Old", "replied", at)],
});
const REASON = field("fld_reason000001", "Pass reason", "select", {
  preset: "raise.pass_reason",
  options: [opt("opt_crowded1", "Competition", "crowded"), opt("opt_ownreas1", "Wants a lead first")],
});

describe("raiseFieldsOf", () => {
  it("binds by the marker only, whatever the label", () => {
    const plain = field("fld_stage0000002", "Stage", "status", { options: [opt("opt_aaaaaaaa", "Research")] });
    expect(raiseFieldsOf([plain]).setUp).toBe(false);
    const r = raiseFieldsOf([plain, STAGE, REASON]);
    expect(r.setUp).toBe(true);
    expect(r.stage!.field.key).toBe(STAGE.key);
    expect(r.byPreset["raise.pass_reason"]!.key).toBe(REASON.key);
    expect(isSetUp([STAGE])).toBe(true);
  });

  it("ignores archived fields, and the first live one wins", () => {
    const archived = { ...STAGE, key: "fld_stage0000009", archivedAt: at } as RecordField;
    const second = { ...STAGE, key: "fld_stage0000003", label: "Second" } as RecordField;
    expect(raiseFieldsOf([archived]).setUp).toBe(false);
    expect(raiseFieldsOf([archived, STAGE, second]).stage!.field.key).toBe(STAGE.key);
  });

  it("gives each stage option its role, a team's own option in play, and keeps archived ones marked", () => {
    const r = raiseFieldsOf([STAGE]);
    expect(r.stage!.options.map((o) => [o.label, o.role, o.archived])).toEqual([
      ["Research", "open", false],
      ["Meeting", "active", false],
      ["Money in", "won", false],
      ["Passed", "passed", false],
      ["Old", "active", true],
    ]);
  });

  it("reads each pass reason's key and area, a team's own under Other", () => {
    const r = raiseFieldsOf([STAGE, REASON]);
    expect(r.passReason!.options.map((o) => [o.label, o.key, o.area])).toEqual([
      ["Competition", "crowded", "market"],
      ["Wants a lead first", null, "other"],
    ]);
  });

  it("needs a Stage that picks one option", () => {
    const text = field("fld_stage0000004", "Stage", "text", { preset: "raise.stage" });
    const multi = field("fld_stage0000005", "Stage", "multi_select", { preset: "raise.stage", options: [] });
    expect(raiseFieldsOf([text]).setUp).toBe(false);
    expect(raiseFieldsOf([multi]).setUp).toBe(false);
  });

  it("knows which kits a Stage holds, and names the board", () => {
    expect(kindsOf(raiseFieldsOf([STAGE]).stage!.options)).toEqual(["raising"]);
    const funding = field("fld_stage0000006", "Stage", "status", { preset: "raise.stage", options: [opt("opt_plan0001", "Plan", "plan"), opt("opt_passed02", "Passed", "passed")] });
    expect(raiseFieldsOf([funding]).kinds).toEqual(["funding"]);
    expect(boardKind(["funding"])).toBe("funding");
    expect(boardKind(["raising", "funding"])).toBe("raising");
    expect(boardKind([])).toBe("raising");
    // Only an archived raising stage: not a raising board.
    expect(kindsOf([{ preset: "replied", archived: true }])).toEqual([]);
  });
});
