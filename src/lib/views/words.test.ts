import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { RecordField } from "@/lib/types/recordField";
import { amountWords, builtInFilterLabel, filterInWords, filtersInWords, OP_LABEL, sortInWords, VIEW_MESSAGES, viewErrorText, type ViewNames } from "./words";
import { BUILT_IN_FILTERS } from "./types";

const at = "2026-11-01T00:00:00.000Z";
const f = (key: string, label: string, type: RecordField["type"], extra: Partial<RecordField> = {}) =>
  ({ key, label, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;
const TYPE = f("fld_type00000001", "Customer type", "select", { options: [{ id: "opt_retail01", label: "Retail" }, { id: "opt_whole001", label: "Wholesale" }] });
const ORDER = f("fld_order0000001", "Last order", "date");
const SPEND = f("fld_spend0000001", "Spend this year", "currency", { currency: "GBP" });
const OWNER = f("fld_owner0000001", "Account owner", "team_member");
const names: ViewNames = {
  fields: [TYPE, ORDER, SPEND, OWNER],
  launches: [{ id: "camp_1", name: "Spring bulb club" }],
  products: [{ id: "con_1", name: "Fernhill online shop" }],
  team: [{ id: "u_alex", name: "Alex Morgan" }],
  ideas: true,
};

describe("a view in words", () => {
  it("reads each filter as a sentence", () => {
    expect(filterInWords({ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }, names)).toBe("Customer type is Wholesale");
    expect(filterInWords({ on: TYPE.key, op: "any_of", value: ["opt_whole001", "opt_retail01"] }, names)).toBe("Customer type is any of Wholesale and Retail");
    expect(filterInWords({ on: TYPE.key, op: "none_of", value: ["opt_retail01"] }, names)).toBe("Customer type isn't Retail");
    expect(filterInWords({ on: ORDER.key, op: "in_last", value: 60 }, names)).toBe("Last order in the last 60 days");
    expect(filterInWords({ on: ORDER.key, op: "over_ago", value: 1 }, names)).toBe("Last order more than 1 day ago");
    expect(filterInWords({ on: ORDER.key, op: "before", value: "2026-11-12" }, names)).toBe("Last order is before 12 Nov 2026");
    expect(filterInWords({ on: SPEND.key, op: "gt", value: 100000 }, names)).toBe("Spend this year is more than £1,000.00");
    expect(filterInWords({ on: "can_email", op: "is", value: true }, names)).toBe("Can email is Yes");
    expect(filterInWords({ on: "launch", op: "any_of", value: ["camp_1"] }, names)).toBe("Idea is Spring bulb club");
    expect(filterInWords({ on: "stage", op: "any_of", value: ["con_1:stuck"] }, names)).toBe("Stage is Stuck");
    expect(filterInWords({ on: OWNER.key, op: "any_of", value: ["u_alex"] }, names)).toBe("Account owner is Alex Morgan");
    // Without the team's names (Vizzy), a team member is never named.
    expect(filterInWords({ on: OWNER.key, op: "any_of", value: ["u_alex", "u_sam"] }, { ...names, team: undefined })).toBe("Account owner is one of 2 team members");
    expect(filterInWords({ on: ORDER.key, op: "empty" }, names)).toBe("Last order is empty");
  });

  it("names a product group from the saved views' names, or from its product", () => {
    const group = { on: "group", op: "any_of" as const, value: ["con_1:ws-42"] };
    expect(filterInWords(group, { ...names, groups: [{ id: "con_1:ws-42", label: "Workspace Hillside" }] })).toBe("Product group is Workspace Hillside");
    expect(filterInWords(group, names)).toBe("Product group is a group in Fernhill online shop");
    expect(filterInWords({ ...group, value: ["con_gone:ws-42"] }, names)).toBe("Product group is A product group");
  });

  it("joins filters as the view does, and names the sort", () => {
    const fs = [
      { on: TYPE.key, op: "any_of" as const, value: ["opt_whole001"] },
      { on: "can_email", op: "is" as const, value: true },
    ];
    expect(filtersInWords(fs, "all", names)).toBe("Customer type is Wholesale and Can email is Yes");
    expect(filtersInWords(fs, "any", names)).toBe("Customer type is Wholesale or Can email is Yes");
    expect(filtersInWords([], "all", names)).toBe("Everyone");
    expect(sortInWords({ by: SPEND.key, dir: "desc" }, names)).toBe("Spend this year, high to low");
    expect(sortInWords(null, names)).toBe("Most recently active first");
    expect(amountWords(482000, "GBP")).toBe("£4,820.00");
    expect(amountWords(1000, "JPY")).toMatch(/¥1,000$/);
  });

  it("keeps every word people see to house style", () => {
    const words = [
      ...Object.values(VIEW_MESSAGES),
      ...Object.values(OP_LABEL),
      ...BUILT_IN_FILTERS.flatMap((b) => [builtInFilterLabel(b, true), builtInFilterLabel(b, false)]),
    ];
    for (const w of words) expect([...dashesIn(w), ...aiTellsIn(w)], w).toEqual([]);
    expect(viewErrorText("views_busy")).toBe("Views are busy. Try again in a moment.");
    expect(viewErrorText("something_else")).toBe(VIEW_MESSAGES.failed);
  });
});
