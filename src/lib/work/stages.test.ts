import { describe, expect, it } from "vitest";
import { PLACES } from "@/lib/ontology/types";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { COMPANY_STAGE_IDS, COMPANY_STAGES, isCompanyStage, readStage, stageById, stageLabel } from "./stages";

describe("the stages of the Path", () => {
  it("are the ten stages, numbered 1 to 10, in plain words", () => {
    expect(COMPANY_STAGES.map((s) => s.id)).toEqual([...COMPANY_STAGE_IDS]);
    expect(COMPANY_STAGES.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(COMPANY_STAGES.map(stageLabelOf)).toEqual(["1 Idea", "2 Test", "3 Set up", "4 Build", "5 Market", "6 Customers", "7 Billing and tax", "8 Support", "9 Expand", "10 Improve"]);
    for (const s of COMPANY_STAGES) expect([...dashesIn(s.label), ...aiTellsIn(s.label)], s.id).toEqual([]);
  });

  it("sit on a place of the ontology, and reach every stage of Home's growth path", () => {
    for (const s of COMPANY_STAGES) expect(PLACES, s.id).toContain(s.place);
    const keys = new Set(COMPANY_STAGES.map((s) => s.pathKey).filter(Boolean));
    expect([...keys].sort()).toEqual(["grow", "launch", "product", "ready", "retain"]);
    expect(stageById("market")).toMatchObject({ place: "content", pathKey: "grow" });
    expect(stageById("customers")).toMatchObject({ place: "customers", pathKey: "retain" });
    expect(stageById("nope")).toBeUndefined();
  });

  it("reads a stage from what a sheet or a person typed", () => {
    expect(readStage("5 Market")).toBe("market");
    expect(readStage("market")).toBe("market");
    expect(readStage(" MARKET ")).toBe("market");
    expect(readStage("7")).toBe("billing_tax");
    expect(readStage("Billing and tax")).toBe("billing_tax");
    expect(readStage("set up")).toBe("set_up");
    expect(readStage("set_up")).toBe("set_up");
    expect(readStage("3. Set up")).toBe("set_up");
    expect(readStage("")).toBeNull();
    expect(readStage("Launch")).toBeNull();
    expect(readStage("11")).toBeNull();
    expect(isCompanyStage("improve")).toBe(true);
    expect(isCompanyStage("Improve")).toBe(false);
  });
});

function stageLabelOf(s: (typeof COMPANY_STAGES)[number]): string {
  return stageLabel(s.id);
}
