import { describe, expect, it } from "vitest";
import type { RecordField } from "@/lib/types/recordField";
import { builtInTag, checkFilter, checkForSave, columnKind, holdsTypedWords, isComplete, isSortable, opsFor, startTags } from "./conditions";
import { emptyView, ViewDefinitionSchema, valueFits, type ViewDefinition } from "./types";

const at = "2026-11-01T00:00:00.000Z";
const field = (key: string, type: RecordField["type"], extra: Partial<RecordField> = {}): RecordField =>
  ({ key, label: key, type, object: "person", archivedAt: null, createdAt: at, createdBy: null, ...extra }) as RecordField;

const TYPE = field("fld_type00000001", "select", {
  options: [
    { id: "opt_retail01", label: "Retail" },
    { id: "opt_whole001", label: "Wholesale" },
    { id: "opt_trade001", label: "Trade", archivedAt: at },
  ],
});
const SIZES = field("fld_sizes0000001", "multi_select", { options: [{ id: "opt_large001", label: "Large" }, { id: "opt_small001", label: "Small" }] });
const NOTES = field("fld_notes0000001", "text");
const SPEND = field("fld_spend0000001", "currency", { currency: "GBP" });
const ORDER = field("fld_order0000001", "date");
const TRADE = field("fld_trade0000001", "checkbox");
const MAIL = field("fld_mail00000001", "email");
const OWNER = field("fld_owner0000001", "team_member");
const OLD = field("fld_old000000001", "select", { archivedAt: at, options: [{ id: "opt_large001", label: "Large" }] });
const FIELDS = [TYPE, SIZES, NOTES, SPEND, ORDER, TRADE, MAIL, OWNER, OLD];

const view = (over: Partial<ViewDefinition>): ViewDefinition => ({ ...emptyView(), ...over });

describe("what each filter offers", () => {
  it("gives email, phone and link fields only empty and not empty", () => {
    for (const t of ["email", "phone", "link"] as const) expect(opsFor(t)).toEqual(["empty", "not_empty"]);
  });

  it("gives every one of the twelve types and every built in filter a comparison", () => {
    for (const t of ["text", "number", "currency", "date", "checkbox", "select", "multi_select", "status", "team_member", "tags", "group", "flag", "instant", "words"] as const) {
      expect(opsFor(t).length, t).toBeGreaterThan(0);
    }
    expect(opsFor("multi_select")).toContain("all_of");
    expect(opsFor("select")).not.toContain("all_of");
  });

  it("checks each comparison's value", () => {
    expect(valueFits("any_of", ["opt_retail01"])).toBe(true);
    expect(valueFits("any_of", [])).toBe(false);
    expect(valueFits("any_of", Array.from({ length: 21 }, (_, i) => `v${i}`))).toBe(false);
    expect(valueFits("is", true)).toBe(true);
    expect(valueFits("between", [1, 5])).toBe(true);
    expect(valueFits("between", [5, 1])).toBe(false);
    expect(valueFits("on", "2026-02-30")).toBe(false);
    expect(valueFits("in_last", 60)).toBe(true);
    expect(valueFits("in_last", 0)).toBe(false);
    expect(valueFits("contains", "  ")).toBe(false);
    expect(valueFits("empty", undefined)).toBe(true);
    expect(valueFits("empty", "x")).toBe(false);
  });
});

describe("built in filters", () => {
  it("read the People list's tags", () => {
    expect(builtInTag("launch", "camp_1")).toBe("launch:camp_1");
    expect(builtInTag("via", "site")).toBe("via:site");
    expect(builtInTag("via", "email")).toBeNull();
    expect(builtInTag("stage", "con_1:stuck")).toBe("stage:con_1:stuck");
    expect(builtInTag("quiet", "con_1")).toBe("quiet:con_1");
    expect(builtInTag("group", "con_1:ws.42")).toBe("group:con_1:ws.42");
    expect(builtInTag("launches_many")).toBe("launches:many");
  });
});

describe("a filter against the field list", () => {
  it("is ignored on an archived field, and leaves an archived option out", () => {
    expect(checkFilter({ on: OLD.key, op: "any_of", value: ["opt_large001"] }, FIELDS)).toMatchObject({ use: null, flag: "archived_field" });
    expect(checkFilter({ on: TYPE.key, op: "any_of", value: ["opt_trade001"] }, FIELDS)).toMatchObject({ use: null, flag: "archived_option" });
    expect(checkFilter({ on: TYPE.key, op: "any_of", value: ["opt_trade001", "opt_whole001"] }, FIELDS)).toMatchObject({
      use: { value: ["opt_whole001"] },
      flag: "archived_option",
    });
    expect(checkFilter({ on: "fld_gone00000001", op: "empty" }, FIELDS)).toMatchObject({ use: null, flag: "unknown_field" });
    expect(checkFilter({ on: MAIL.key, op: "contains", value: "x" }, FIELDS)).toMatchObject({ use: null, flag: "invalid" });
    expect(checkFilter({ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }, FIELDS)).toMatchObject({ flag: null });
  });

  it("names the groups a match all view can start from", () => {
    expect(startTags({ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }, TYPE)).toEqual(["field:fld_type00000001:opt_whole001"]);
    expect(startTags({ on: TYPE.key, op: "any_of", value: ["opt_whole001", "opt_retail01"] }, TYPE)).toEqual([]);
    expect(startTags({ on: SIZES.key, op: "all_of", value: ["opt_large001", "opt_small001"] }, SIZES)).toHaveLength(2);
    expect(startTags({ on: TRADE.key, op: "is", value: true }, TRADE)).toEqual(["field:fld_trade0000001:yes"]);
    expect(startTags({ on: TRADE.key, op: "is", value: false }, TRADE)).toEqual([]);
    expect(startTags({ on: "launch", op: "any_of", value: ["camp_1"] }, null)).toEqual(["launch:camp_1"]);
    expect(startTags({ on: "launch", op: "none_of", value: ["camp_1"] }, null)).toEqual([]);
    expect(startTags({ on: "launches_many", op: "is", value: true }, null)).toEqual(["launches:many"]);
    expect(startTags({ on: "can_email", op: "is", value: true }, null)).toEqual([]);
  });
});

describe("saving a view", () => {
  it("refuses typed words, naming each filter that holds them", () => {
    const r = checkForSave(
      view({
        filters: [
          { on: ORDER.key, op: "in_last", value: 60 },
          { on: "email_domain", op: "equals", value: "greenroom-cafe.example" },
          { on: NOTES.key, op: "contains", value: "repot" },
        ],
      }),
      FIELDS,
    );
    expect(r).toEqual({ ok: false, error: "typed_words", filters: [1, 2] });
    expect(holdsTypedWords({ op: "not_empty" })).toBe(false);
    // Whether there is a domain or a text value holds no words: it saves.
    expect(checkForSave(view({ filters: [{ on: NOTES.key, op: "not_empty" }, { on: "email_domain", op: "empty" }] }), FIELDS).ok).toBe(true);
  });

  it("keeps archived fields and options, and refuses ones the list never had", () => {
    expect(checkForSave(view({ filters: [{ on: OLD.key, op: "any_of", value: ["opt_large001"] }] }), FIELDS).ok).toBe(true);
    expect(checkForSave(view({ filters: [{ on: TYPE.key, op: "any_of", value: ["opt_trade001"] }] }), FIELDS).ok).toBe(true);
    expect(checkForSave(view({ filters: [{ on: TYPE.key, op: "any_of", value: ["opt_nothere1"] }] }), FIELDS)).toMatchObject({ error: "invalid_view" });
    expect(checkForSave(view({ filters: [{ on: "fld_gone00000001", op: "empty" }] }), FIELDS)).toMatchObject({ error: "invalid_view" });
    expect(checkForSave(view({ filters: [{ on: MAIL.key, op: "contains", value: "x" }] }), FIELDS)).toMatchObject({ error: "invalid_view" });
    expect(checkForSave(view({ columns: ["person", "fld_gone00000001"] }), FIELDS)).toMatchObject({ error: "invalid_view" });
  });

  it("needs Person first, each column once, at most ten, and a sort with an order", () => {
    expect(ViewDefinitionSchema.safeParse(view({ columns: ["last_active", "person"] })).success).toBe(false);
    expect(ViewDefinitionSchema.safeParse(view({ columns: ["person", "stage", "stage"] })).success).toBe(false);
    expect(ViewDefinitionSchema.safeParse(view({ columns: ["person", ...FIELDS.map((f) => f.key), "stage"] })).success).toBe(false);
    expect(checkForSave(view({ sort: { by: SPEND.key, dir: "desc" } }), FIELDS).ok).toBe(true);
    expect(checkForSave(view({ sort: { by: "where_from", dir: "desc" } }), FIELDS)).toMatchObject({ error: "invalid_view", reason: "sort" });
    expect(checkForSave(view({ sort: { by: SIZES.key, dir: "asc" } }), FIELDS)).toMatchObject({ error: "invalid_view", reason: "sort" });
    expect(isSortable(columnKind(OLD.key, FIELDS))).toBe(false);
  });

  it("refuses more than ten filters and a filter with a value that doesn't fit", () => {
    const many = Array.from({ length: 11 }, () => ({ on: "can_email", op: "is" as const, value: true }));
    expect(checkForSave(view({ filters: many }), FIELDS)).toMatchObject({ error: "invalid_view" });
    expect(checkForSave(view({ filters: [{ on: SPEND.key, op: "gt", value: "lots" as unknown as number }] }), FIELDS)).toMatchObject({ error: "invalid_view" });
  });
});

describe("a filter being built", () => {
  it("applies only once it has a value", () => {
    expect(isComplete({ on: TYPE.key, op: "any_of", value: [] })).toBe(false);
    expect(isComplete({ on: TYPE.key, op: "any_of" })).toBe(false);
    expect(isComplete({ on: TYPE.key, op: "empty" })).toBe(true);
    expect(isComplete({ on: NOTES.key, op: "contains", value: "" })).toBe(false);
    expect(isComplete({ on: TRADE.key, op: "is", value: false })).toBe(true);
  });
});

describe("a view from what the list was showing", () => {
  it("turns the group and Only people we can email into filters", async () => {
    const { filtersFromGroup } = await import("./conditions");
    expect(filtersFromGroup("all", false)).toEqual([]);
    expect(filtersFromGroup("all", true)).toEqual([{ on: "can_email", op: "is", value: true }]);
    expect(filtersFromGroup("launch:camp_1", false)).toEqual([{ on: "launch", op: "any_of", value: ["camp_1"] }]);
    expect(filtersFromGroup("via:site", false)).toEqual([{ on: "via", op: "any_of", value: ["site"] }]);
    expect(filtersFromGroup("launches:many", false)).toEqual([{ on: "launches_many", op: "is", value: true }]);
    expect(filtersFromGroup("stage:con_1:stuck", false)).toEqual([{ on: "stage", op: "any_of", value: ["con_1:stuck"] }]);
    expect(filtersFromGroup("quiet:con_1", false)).toEqual([{ on: "quiet", op: "any_of", value: ["con_1"] }]);
    expect(filtersFromGroup("group:con_1:ws.4:a", false)).toEqual([{ on: "group", op: "any_of", value: ["con_1:ws.4:a"] }]);
    expect(filtersFromGroup(`field:${TYPE.key}:opt_whole001`, false)).toEqual([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }]);
    expect(filtersFromGroup(`field:${TRADE.key}:yes`, false)).toEqual([{ on: TRADE.key, op: "is", value: true }]);
    // Each one starts a match all view from the same group, so it counts the same.
    expect(startTags(filtersFromGroup("launch:camp_1", false)[0]!, null)).toEqual(["launch:camp_1"]);
    expect(startTags(filtersFromGroup(`field:${TRADE.key}:yes`, false)[0]!, TRADE)).toEqual([`field:${TRADE.key}:yes`]);
  });
});
